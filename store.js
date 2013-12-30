/*jshint node:true, indent:2, laxcomma:true, eqnull:true, unused:true, undef:true */

'use strict';

/**
 * Redis Storage Backend
 */

var redis = require('redis')
  , suspend = require('suspend')
  ;

var HASH_KEY = 'store';


function Store() {
  this._redis = redis.createClient.apply(null, arguments);
}

Store.prototype.add = function(info_hash) {
  
};

Store.prototype.remove = function(info_hash) {
  
};

Store.prototype.list = function() {
  
};

Store.prototype.get = /*suspend.async(function *(info_hash) {
  return yield redis.hget(HASH_KEY, info_hash, suspend.resume());
});*/ null;

module.exports = Store;
