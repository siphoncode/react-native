/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */
'use strict';

var getInverseDependencies = require('node-haste').getInverseDependencies;
var querystring = require('querystring');
var url = require('url');

/**
 * Attaches a WebSocket based connection to the Packager to expose
 * Hot Module Replacement updates to the simulator.
 */
function attachHMRServer(_ref) {
  var httpServer = _ref.httpServer;
  var path = _ref.path;
  var packagerServer = _ref.packagerServer;

  var client = null;

  function disconnect() {
    client = null;
    packagerServer.setHMRFileChangeListener(null);
  }

  // For the give platform and entry file, returns a promise with:
  //   - The full list of dependencies.
  //   - The shallow dependencies each file on the dependency list has
  //   - Inverse shallow dependencies map
  function getDependencies(platform, bundleEntry) {
    return packagerServer.getDependencies({
      platform: platform,
      dev: true,
      entryFile: bundleEntry
    }).then(function (response) {
      // for each dependency builds the object:
      // `{path: '/a/b/c.js', deps: ['modA', 'modB', ...]}`
      return Promise.all(Object.values(response.dependencies).map(function (dep) {
        return dep.getName().then(function (depName) {
          if (dep.isAsset() || dep.isAsset_DEPRECATED() || dep.isJSON()) {
            return Promise.resolve({ path: dep.path, deps: [] });
          }
          return packagerServer.getShallowDependencies(dep.path).then(function (deps) {
            return {
              path: dep.path,
              name: depName,
              deps: deps
            };
          });
        });
      })).then(function (deps) {
        // list with all the dependencies' filenames the bundle entry has
        var dependenciesCache = response.dependencies.map(function (dep) {
          return dep.path;
        });

        // map from module name to path
        var moduleToFilenameCache = Object.create(null);
        deps.forEach(function (dep) {
          return moduleToFilenameCache[dep.name] = dep.path;
        });

        // map that indicates the shallow dependency each file included on the
        // bundle has
        var shallowDependencies = Object.create(null);
        deps.forEach(function (dep) {
          return shallowDependencies[dep.path] = dep.deps;
        });

        // map from module name to the modules' dependencies the bundle entry
        // has
        var dependenciesModulesCache = Object.create(null);
        return Promise.all(response.dependencies.map(function (dep) {
          return dep.getName().then(function (depName) {
            dependenciesModulesCache[depName] = dep;
          });
        })).then(function () {
          return getInverseDependencies(response).then(function (inverseDependenciesCache) {
            return {
              dependenciesCache: dependenciesCache,
              dependenciesModulesCache: dependenciesModulesCache,
              shallowDependencies: shallowDependencies,
              inverseDependenciesCache: inverseDependenciesCache,
              resolutionResponse: response
            };
          });
        });
      });
    });
  }

  var WebSocketServer = require('ws').Server;
  var wss = new WebSocketServer({
    server: httpServer,
    path: path
  });

  console.log('[Hot Module Replacement] Server listening on', path);
  wss.on('connection', function (ws) {
    console.log('[Hot Module Replacement] Client connected');
    var params = querystring.parse(url.parse(ws.upgradeReq.url).query);

    getDependencies(params.platform, params.bundleEntry).then(function (_ref2) {
      var dependenciesCache = _ref2.dependenciesCache;
      var dependenciesModulesCache = _ref2.dependenciesModulesCache;
      var shallowDependencies = _ref2.shallowDependencies;
      var inverseDependenciesCache = _ref2.inverseDependenciesCache;

      client = {
        ws: ws,
        platform: params.platform,
        bundleEntry: params.bundleEntry,
        dependenciesCache: dependenciesCache,
        dependenciesModulesCache: dependenciesModulesCache,
        shallowDependencies: shallowDependencies,
        inverseDependenciesCache: inverseDependenciesCache
      };

      packagerServer.setHMRFileChangeListener(function (filename, stat) {
        if (!client) {
          return;
        }
        console.log('[Hot Module Replacement] File change detected (' + time() + ')');

        client.ws.send(JSON.stringify({ type: 'update-start' }));
        stat.then(function () {
          return packagerServer.getShallowDependencies(filename).then(function (deps) {
            if (!client) {
              return [];
            }

            // if the file dependencies have change we need to invalidate the
            // dependencies caches because the list of files we need to send
            // to the client may have changed
            var oldDependencies = client.shallowDependencies[filename];
            if (arrayEquals(deps, oldDependencies)) {
              // Need to create a resolution response to pass to the bundler
              // to process requires after transform. By providing a
              // specific response we can compute a non recursive one which
              // is the least we need and improve performance.
              return packagerServer.getDependencies({
                platform: client.platform,
                dev: true,
                entryFile: filename,
                recursive: true
              }).then(function (response) {
                var module = packagerServer.getModuleForPath(filename);

                return response.copy({ dependencies: [module] });
              });
            }

            // if there're new dependencies compare the full list of
            // dependencies we used to have with the one we now have
            return getDependencies(client.platform, client.bundleEntry).then(function (_ref3) {
              var dependenciesCache = _ref3.dependenciesCache;
              var dependenciesModulesCache = _ref3.dependenciesModulesCache;
              var shallowDependencies = _ref3.shallowDependencies;
              var inverseDependenciesCache = _ref3.inverseDependenciesCache;
              var resolutionResponse = _ref3.resolutionResponse;

              if (!client) {
                return {};
              }

              // build list of modules for which we'll send HMR updates
              var modulesToUpdate = [packagerServer.getModuleForPath(filename)];
              Object.keys(dependenciesModulesCache).forEach(function (module) {
                if (!client.dependenciesModulesCache[module]) {
                  modulesToUpdate.push(dependenciesModulesCache[module]);
                }
              });

              // Need to send modules to the client in an order it can
              // process them: if a new dependency graph was uncovered
              // because a new dependency was added, the file that was
              // changed, which is the root of the dependency tree that
              // will be sent, needs to be the last module that gets
              // processed. Reversing the new modules makes sense
              // because we get them through the resolver which returns
              // a BFS ordered list.
              modulesToUpdate.reverse();

              // invalidate caches
              client.dependenciesCache = dependenciesCache;
              client.dependenciesModulesCache = dependenciesModulesCache;
              client.shallowDependencies = shallowDependencies;

              return resolutionResponse.copy({
                dependencies: modulesToUpdate
              });
            });
          }).then(function (resolutionResponse) {
            if (!client) {
              return;
            }

            // make sure the file was modified is part of the bundle
            if (!client.shallowDependencies[filename]) {
              return;
            }

            var httpServerAddress = httpServer.address();

            // Sanitize the value from the HTTP server
            var packagerHost = 'localhost';
            if (httpServer.address().address && httpServer.address().address !== '::' && httpServer.address().address !== '') {
              packagerHost = httpServerAddress.address;
            }

            var packagerPort = httpServerAddress.port;

            return packagerServer.buildBundleForHMR({
              entryFile: client.bundleEntry,
              platform: client.platform,
              resolutionResponse: resolutionResponse
            }, packagerHost, packagerPort);
          }).then(function (bundle) {
            if (!client || !bundle || bundle.isEmpty()) {
              return;
            }

            return JSON.stringify({
              type: 'update',
              body: {
                modules: bundle.getModulesNamesAndCode(),
                inverseDependencies: inverseDependenciesCache,
                sourceURLs: bundle.getSourceURLs(),
                sourceMappingURLs: bundle.getSourceMappingURLs()
              }
            });
          }).catch(function (error) {
            // send errors to the client instead of killing packager server
            var body = void 0;
            if (error.type === 'TransformError' || error.type === 'NotFoundError' || error.type === 'UnableToResolveError') {
              body = {
                type: error.type,
                description: error.description,
                filename: error.filename,
                lineNumber: error.lineNumber
              };
            } else {
              console.error(error.stack || error);
              body = {
                type: 'InternalError',
                description: 'react-packager has encountered an internal error, ' + 'please check your terminal error output for more details'
              };
            }

            return JSON.stringify({ type: 'error', body: body });
          }).then(function (update) {
            if (!client || !update) {
              return;
            }

            console.log('[Hot Module Replacement] Sending HMR update to client (' + time() + ')');
            client.ws.send(update);
          });
        }, function () {
          // do nothing, file was removed
        }).then(function () {
          client.ws.send(JSON.stringify({ type: 'update-done' }));
        });
      });

      client.ws.on('error', function (e) {
        console.error('[Hot Module Replacement] Unexpected error', e);
        disconnect();
      });

      client.ws.on('close', function () {
        return disconnect();
      });
    }).done();
  });
}

function arrayEquals(arrayA, arrayB) {
  arrayA = arrayA || [];
  arrayB = arrayB || [];
  return arrayA.length === arrayB.length && arrayA.every(function (element, index) {
    return element === arrayB[index];
  });
}

function time() {
  var date = new Date();
  return date.getHours() + ':' + date.getMinutes() + ':' + date.getSeconds() + ':' + date.getMilliseconds();
}

module.exports = attachHMRServer;
