/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */
'use strict';

function attachToServer(server, path) {
  var WebSocketServer = require('ws').Server;
  var wss = new WebSocketServer({
    server: server,
    path: path
  });
  var debuggerSocket, clientSocket;

  function send(dest, message) {
    if (!dest) {
      return;
    }

    try {
      dest.send(message);
    } catch (e) {
      console.warn(e);
      // Sometimes this call throws 'not opened'
    }
  }

  wss.on('connection', function (ws) {
    var url = ws.upgradeReq.url;


    if (url.indexOf('role=debugger') > -1) {
      if (debuggerSocket) {
        ws.close(1011, 'Another debugger is already connected');
        return;
      }
      debuggerSocket = ws;
      debuggerSocket.onerror = debuggerSocket.onclose = function () {
        debuggerSocket = null;
        if (clientSocket) {
          clientSocket.close(1011, 'Debugger was disconnected');
        }
      };
      debuggerSocket.onmessage = function (_ref) {
        var data = _ref.data;
        return send(clientSocket, data);
      };
    } else if (url.indexOf('role=client') > -1) {
      if (clientSocket) {
        clientSocket.onerror = clientSocket.onclose = clientSocket.onmessage = null;
        clientSocket.close(1011, 'Another client connected');
      }
      clientSocket = ws;
      clientSocket.onerror = clientSocket.onclose = function () {
        clientSocket = null;
        send(debuggerSocket, JSON.stringify({ method: '$disconnected' }));
      };
      clientSocket.onmessage = function (_ref2) {
        var data = _ref2.data;
        return send(debuggerSocket, data);
      };
    } else {
      ws.close(1011, 'Missing role param');
    }
  });

  return {
    server: wss,
    isChromeConnected: function isChromeConnected() {
      return !!debuggerSocket;
    }
  };
}

module.exports = {
  attachToServer: attachToServer
};
