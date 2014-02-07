/*jshint node:true, indent:2, laxcomma:true, eqnull:true, unused:true, undef:true */

'use strict';

/**
 * Redis Storage Backend
 */

var redis = require('redis')
  , suspend = require('suspend')
  ;

var HASH_KEY = '_mem';


function Store() {
  this._redis = redis.createClient.apply(null, arguments);
}

Store.prototype.add = function(info_hash, val, cb) {
  this._redis.hset(HASH_KEY, info_hash, val, cb);
};


Store.prototype.clear = function() {
  this._redis.del(HASH_KEY);
};


Store.prototype.list = suspend.async(function *() {
  return yield this._redis.hgetall(HASH_KEY, suspend.resume());
});


Store.prototype.exists = suspend.async(function *(info_hash) {
  return yield this._redis.hget(HASH_KEY, info_hash, suspend.resume());
});


module.exports = Store;
