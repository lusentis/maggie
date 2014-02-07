#!/usr/bin/env node
/*jshint node:true, indent:2, laxcomma:true, eqnull:true, unused:true, undef:true */

'use strict';

require('sugar');
var debug = require('debug')('ht')
  , request = require('request')
  , async = require('async')
  , path = require('path')
  , fs = require('fs')
  ;

try {
  var CONFIG = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.ht.json'), { encoding: 'utf8' }));
} catch (e) {
  console.warn('Cannot parse configuration file ~/.ht.json. See README for info.');
}

var TORRENTZ_URL = 'https://torrentz.eu/search?f={q}'
  , TORRENTZ_RESULT_RE = '<div class="results">.*peers.*<dl><dt><a href="\/([0-9a-f]{40})">(.*<span class="s">(.*)<\/span>.*<span class="u">([\d\.,]*)<\/span>.*<span class="d">([\d\.,]*)<\/span>)?'
  , REGEXP = /(.*) ((\d+)x(\d+)(:\d+)?([a-zA-Z]+)?|(season\s\d+))\s*(complete)?\s*(480p|720p|1080p|web-dl|hdtv|dvdrip|bluray|extended bluray)?(.*)/ig
  , TRACKERS = CONFIG.trackers
  ;


(function () {
  var title = process.argv[2];
  
  _getMeta({ title: title, originalTitle: title, subtitles: 'no' }, function (err, meta) {
    if (err) {
      debug('Error getting meta', err);
      return;
    }
    
    if (meta === null || (Array.isArray(meta) && meta.length < 1)) {
      debug('Skipping torrent file because meta is undefined', title);
      return;
    }
    
    debug('Got meta', title, meta);
    
    if (!Array.isArray(meta)) {
      meta = [meta];
    }
    
    meta.forEach(function (meta_item) {
      if (parseInt(meta_item.peers, 10) + parseInt(meta_item.seeds, 10) < 100) {
        debug('Episode', meta_item.episode, 'has too few peers.');
        debug('[ x ] ' + meta_item.season + 'x' + meta_item.episode + ': slow!');
        return;
      }
      
      debug('[ o ] ' + meta_item.season + 'x' + meta_item.episode + ': ' + meta_item.seeds + '/' + meta_item.peers + ' (' + meta_item.size + ') ' + meta_item.infoHash);
      process.stdout.write('' + meta_item.magnet);
      process.stdout.write('\n');
    });
  });
  
})();


function _getMeta(ret, next) {
  var parts = REGEXP.exec(ret.title);
      
  if (parts === null) {
    debug('Torrent did not match regexp', parts, ret.title);
    next(null, null);
    return;
  }

  ret.title = parts[1];
  ret.season = parseInt(parts[3], 10);
  ret.episode = parseInt(parts[4], 10);
  ret.episodeTo = parts[5] && parseInt(parts[5].substring(1), 10);
  ret.isEpisodeRange = !!ret.episodeTo;
  ret.episodeSpecial = parts[6] || '';
  ret.fullSeason = parts[7] || null;
  ret.isFullSeason = !!parts[8];
  ret.quality = parts[9] || '';
  ret.extra = parts[10] || '';
  
  // - Torrent search query
  ret.torrentSearch = _buildSearchQuery(ret);
  
  // - handing episodes range
  if (ret.isEpisodeRange) {
    async.map(Number.range(ret.episode, ret.episodeTo).every(), function (episodeNumber, innerNext) {
      var current = Object.clone(ret);
      current.episode = episodeNumber;
      current.torrentSearch = _buildSearchQuery(current);
      
      _searchAdd(current.torrentSearch.escapeURL(true), function (_, first_result) {
        if (!first_result) {
          debug('Cannot get info_hash from web service (isEpisodeRange===true):', current.torrentSearch, first_result);
          innerNext(null, null);
          return;
        }
        
        current.infoHash = first_result[1];
        current.size = first_result[3];
        current.seeds = first_result[4];
        current.peers = first_result[5];
        current.magnet = 'magnet:?xt=urn:btih:' + current.infoHash + '&' + TRACKERS;
        innerNext(null, current);
      });
      
    }, function (_, episodes) {
      next(null, episodes.compact());
    });
    
  } else {
    
    debug('Req', TORRENTZ_URL.assign({ q: ret.torrentSearch.escapeURL(true) }));
    debug('Parsed meta', ret);

    _searchAdd(ret.torrentSearch.escapeURL(true), function (_, first_result) {
      if (!first_result) {
        debug('Cannot get info_hash from web service (isEpisodeRange===false):', ret.torrentSearch, first_result);
        next(null, null);
        return;
      }
      
      ret.infoHash = first_result[1];
      ret.size = first_result[3];
      ret.seeds = first_result[4];
      ret.peers = first_result[5];
      ret.magnet = 'magnet:?xt=urn:btih:' + ret.infoHash + '&' + TRACKERS;
      next(null, ret);
    });
  }
}


function _buildSearchQuery(ret) {
  var query = [ret.title, ' '];
  if (ret.isFullSeason) {
    query.push(ret.fullSeason);
  } else {
    query.push([
      's' + ((ret.season < 10) ? '0' + ret.season : ret.season),
      'e' + ((ret.episode < 10) ? '0' + ret.episode : ret.episode) + ret.episodeSpecial,
      ' ', ret.quality, ret.extra
    ]);
  }
  query = query.flatten().join('').trim();
  return query;
}


function _searchAdd(query, cb) {
  request({
    url: TORRENTZ_URL.assign({ q: query })
  , strictSSL: true
  , headers: { 'Accept': '*/*', 'User-Agent': 'curl/7.30.0 compatible; rtm bot' }
  }, function (err, _, body) {
    if (err) {
      debug('Torrent search error');
      cb(null, null);
      return;
    }
    
    var first_result = new RegExp(TORRENTZ_RESULT_RE, 'im').exec(body);
    cb(null, first_result);
  });
}
