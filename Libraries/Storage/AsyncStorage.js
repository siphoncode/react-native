/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule AsyncStorage
 * @flow-weak
 */
'use strict';

var NativeModules = require('NativeModules');
var RCTAsyncSQLiteStorage = NativeModules.AsyncSQLiteDBStorage;
var RCTAsyncRocksDBStorage = NativeModules.AsyncRocksDBStorage;
var RCTAsyncFileStorage = NativeModules.AsyncLocalStorage;

// Use RocksDB if available, then SQLite, then file storage.
var RCTAsyncStorage = RCTAsyncRocksDBStorage || RCTAsyncSQLiteStorage || RCTAsyncFileStorage;

var prefixKey = function(key: string) {
  var a = __SIPHON.appID;
  if (a == undefined || a == null || a.length < 1) {
    throw 'Global appID must be set.';
  }

  return a + '-' + key;
};

var keyAllowed = function(key: string) {
  return key.includes(__SIPHON.appID);
};

var AsyncStorage = {
  /**
   * Fetches `key` and passes the result to `callback`, along with an `Error` if
   * there is any. Returns a `Promise` object.
   */
  getItem: function(
    key: string,
    callback?: ?(error: ?Error, result: ?string) => void
  ): Promise {
    key = prefixKey(key);
    return new Promise((resolve, reject) => {
      RCTAsyncStorage.multiGet([key], function(errors, result) {
        // Unpack result to get value from [[key,value]]
        var value = (result && result[0] && result[0][1]) ? result[0][1] : null;
        var errs = convertErrors(errors);
        callback && callback(errs && errs[0], value);
        if (errs) {
          reject(errs[0]);
        } else {
          resolve(value);
        }
      });
    });
  },

  /**
   * Sets `value` for `key` and calls `callback` on completion, along with an
   * `Error` if there is any. Returns a `Promise` object.
   */
  setItem: function(
    key: string,
    value: string,
    callback?: ?(error: ?Error) => void
  ): Promise {
    key = prefixKey(key);
    return new Promise((resolve, reject) => {
      RCTAsyncStorage.multiSet([[key,value]], function(errors) {
        var errs = convertErrors(errors);
        callback && callback(errs && errs[0]);
        if (errs) {
          reject(errs[0]);
        } else {
          resolve(null);
        }
      });
    });
  },

  /**
   * Returns a `Promise` object.
   */
  removeItem: function(
    key: string,
    callback?: ?(error: ?Error) => void
  ): Promise {
    key = prefixKey(key);
    return new Promise((resolve, reject) => {
      RCTAsyncStorage.multiRemove([key], function(errors) {
        var errs = convertErrors(errors);
        callback && callback(errs && errs[0]);
        if (errs) {
          reject(errs[0]);
        } else {
          resolve(null);
        }
      });
    });
  },

  /**
   * Merges existing value with input value, assuming they are stringified json.
   * Returns a `Promise` object. Not supported by all native implementations.
   */
  mergeItem: function(
    key: string,
    value: string,
    callback?: ?(error: ?Error) => void
  ): Promise {
    key = prefixKey(key);
    return new Promise((resolve, reject) => {
      RCTAsyncStorage.multiMerge([[key,value]], function(errors) {
        var errs = convertErrors(errors);
        callback && callback(errs && errs[0]);
        if (errs) {
          reject(errs[0]);
        } else {
          resolve(null);
        }
      });
    });
  },

  /**
   * Erases *all* AsyncStorage for all clients, libraries, etc.  You probably
   * don't want to call this - use removeItem or multiRemove to clear only your
   * own keys instead. Returns a `Promise` object.
   */
  clear: function(callback?: ?(error: ?Error) => void): Promise {
    return new Promise((resolve, reject) => {
      AsyncStorage.getAllKeys().then((keys) => {
        AsyncStorage.multiRemove(keys).then(() => {
          resolve(null);
        }).catch((error) => {
          reject(error);
        });
      }).catch((error) => {
        reject(error);
      });
    });
  },

  /**
   * Gets *all* keys known to the app, for all callers, libraries, etc. Returns a `Promise` object.
   */
  getAllKeys: function(callback?: ?(error: ?Error, keys: ?Array<string>) => void): Promise {
    return new Promise((resolve, reject) => {
      RCTAsyncStorage.getAllKeys(function(error, keys) {
        callback && callback(convertError(error), keys);
        if (error) {
          reject(convertError(error));
        } else {
          resolve(keys.filter((key) => {
            return keyAllowed(key);
          }));
        }
      });
    });
  },

  /**
   * The following batched functions are useful for executing a lot of
   * operations at once, allowing for native optimizations and provide the
   * convenience of a single callback after all operations are complete.
   *
   * These functions return arrays of errors, potentially one for every key.
   * For key-specific errors, the Error object will have a key property to
   * indicate which key caused the error.
   */

  /**
   * multiGet invokes callback with an array of key-value pair arrays that
   * matches the input format of multiSet. Returns a `Promise` object.
   *
   *   multiGet(['k1', 'k2'], cb) -> cb([['k1', 'val1'], ['k2', 'val2']])
   */
  multiGet: function(
    keys: Array<string>,
    callback?: ?(errors: ?Array<Error>, result: ?Array<Array<string>>) => void
  ): Promise {
    keys = keys.map(prefixKey);
    return new Promise((resolve, reject) => {
      RCTAsyncStorage.multiGet(keys, function(errors, result) {
        var error = convertErrors(errors);
        callback && callback(error, result);
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      });
    });
  },

  /**
   * multiSet and multiMerge take arrays of key-value array pairs that match
   * the output of multiGet, e.g. Returns a `Promise` object.
   *
   *   multiSet([['k1', 'val1'], ['k2', 'val2']], cb);
   */
  multiSet: function(
    keyValuePairs: Array<Array<string>>,
    callback?: ?(errors: ?Array<Error>) => void
  ): Promise {
    return new Promise((resolve, reject) => {
      keyValuePairs = keyValuePairs.map((arr) => {
        return [prefixKey(arr[0]), arr[1]];
      });
      RCTAsyncStorage.multiSet(keyValuePairs, function(errors) {
        var error = convertErrors(errors);
        callback && callback(error);
        if (error) {
          reject(error);
        } else {
          resolve(null);
        }
      });
    });
  },

  /**
   * Delete all the keys in the `keys` array. Returns a `Promise` object.
   */
  multiRemove: function(
    keys: Array<string>,
    callback?: ?(errors: ?Array<Error>) => void
  ): Promise {
    keys = keys.map(prefixKey);
    return new Promise((resolve, reject) => {
      RCTAsyncStorage.multiRemove(keys, function(errors) {
        var error = convertErrors(errors);
        callback && callback(error);
        if (error) {
          reject(error);
        } else {
          resolve(null);
        }
      });
    });
  },

  /**
   * Merges existing values with input values, assuming they are stringified
   * json. Returns a `Promise` object.
   *
   * Not supported by all native implementations.
   */
  multiMerge: function(
    keyValuePairs: Array<Array<string>>,
    callback?: ?(errors: ?Array<Error>) => void
  ): Promise {
    keyValuePairs = keyValuePairs.map((arr) => {
      return [prefixKey(arr[0]), arr[1]];
    });
    return new Promise((resolve, reject) => {
      RCTAsyncStorage.multiMerge(keyValuePairs, function(errors) {
        var error = convertErrors(errors);
        callback && callback(error);
        if (error) {
          reject(error);
        } else {
          resolve(null);
        }
      });
    });
  },
};

// Not all native implementations support merge.
if (!RCTAsyncStorage.multiMerge) {
  delete AsyncStorage.mergeItem;
  delete AsyncStorage.multiMerge;
}

function convertErrors(errs) {
  if (!errs) {
    return null;
  }
  return (Array.isArray(errs) ? errs : [errs]).map((e) => convertError(e));
}

function convertError(error) {
  if (!error) {
    return null;
  }
  var out = new Error(error.message);
  out.key = error.key; // flow doesn't like this :(
  return out;
}

module.exports = AsyncStorage;
