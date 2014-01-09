/*jshint node:true, indent:2, laxcomma:true, eqnull:true, unused:true, undef:true */

'use strict';

var MACHINE = require('config').Machine
  , CONFIG = require('config').Config
  ;


var RSS_URL = CONFIG.RSS_URL
  , TORRENTZ_URL = CONFIG.TORRENTZ_URL
  , TRACKERS = CONFIG.TRACKERS
  , INTERESTED = CONFIG.INTERESTED.split(',').map(function (i) { return new RegExp(i, 'ig'); })
  , TRANSMISSION_URL = require('url').parse(CONFIG.TRANSMISSION_URL)
  , IRC_NICKNAME = CONFIG.IRC_NICKNAME
  , IRC_CHANNEL = CONFIG.IRC_CHANNEL
  , IRC_SERVER = CONFIG.IRC_SERVER
  ;

require('sugar');
var parseRSS = require('parse-rss')
  , coolog = require('coolog')
  , request = require('request')
  , async = require('async')
  , Transmission = require('transmission')
  , mega = require('mega')
  , irc = require('irc')
  , suspend = require('suspend')
  , irrelevant = require('irrelevant')
  , path = require('path')
  , fs = require('fs')
  , Store = require('./store')
  ;

coolog.addChannel({ name: 'root', level: 'debug', appenders: ['console'] });

var logger = coolog.logger('app.js')
  , transmission = new Transmission({ host: TRANSMISSION_URL.hostname, port: TRANSMISSION_URL.port, username: TRANSMISSION_URL.auth.split(':')[0], password: TRANSMISSION_URL.auth.split(':')[1] })
  , megaStorage = mega({})
  , ircc = new irc.Client(IRC_SERVER, IRC_NICKNAME, { debug: false })
  , store = new Store()
  , book = fs.readFileSync('config/book.txt', { encoding: 'utf8' })
  , root = null
  , _cargo
  , _uploading = []
  , _mem = new Store()
  ;

ircc.on('error', function (err) {
  logger.error('IRC Error', err);
});

setTimeout(function () {
  ircc.join(IRC_CHANNEL);
}, 2000);

function _irccsay(msg) {
  ircc.say(IRC_CHANNEL, msg);
}


ircc.on('message', function (nick, to, text) {
  logger.debug('Got message', nick, to, text);
  
  if (to !== IRC_NICKNAME) {
    ircc.say(nick, 'Who are you?');
    return;
  }
  
  if (!root && text === 'I am root') {
    root = nick;
    ircc.say(nick, '' + nick + ' has been granted admin privileges.');
    return;
  }
  
  
  if (text === 'mem?') {
    suspend.run(function *() {
      var mem = yield _mem.list(suspend.resume())
        ;
      
      logger.log('mem', mem);
      
      if (mem === null) {
        ircc.say(nick, irrelevant.encode('no memory', book));
      } else {
        megaStorage.upload('memory-' + new Date().valueOf() + '.txt', Object.values(mem).join('\n'), function (err, file) {
          if (err) {
            logger.error('Cannot store memory', err);
            return;
          }
          
          file.link(function (err, url) {
            if (err) {
              logger.error('Cannot get memory link', err);
              return;
            }
            
            ircc.say(nick, 'mem! ' + irrelevant.encode(url, book));
          });
        });
      }
    });
    
    return;
  }
  
  
  if (text.match(new RegExp(MACHINE.cmd_download_re))) {
    var parsed = new RegExp(MACHINE.cmd_download_re).exec(text);
    
    if (!parsed || !parsed[1]) {
      logger.warn('Invalid command', text, parsed);
      return;
    }
    
    var title = parsed[1];
    
    _getMeta({ title: title, originalTitle: title, subtitles: 'no' }, function (err, meta) {
      if (err) {
        ircc.say(nick, '[ x ]');
        logger.error('Error getting meta', err);
        return;
      }
      
      if (meta === null || (Array.isArray(meta) && meta.length < 1)) {
        ircc.say(nick, '[   ]');
        logger.warn('Skipping torrent file because meta is undefined', title);
        return;
      }
      
      logger.debug('Got meta', title, meta);
      
      if (!Array.isArray(meta)) {
        meta = [meta];
      }
      
      meta.forEach(function (meta_item) {
        if (parseInt(meta_item.peers, 10) + parseInt(meta_item.seeds, 10) < 100) {
          logger.warn('Episode', meta_item.episode, 'has too few peers.');
          ircc.say(nick, '[ x ] ' + meta_item.season + 'x' + meta_item.episode + ': slow!');
          return;
        }
        
        _addTx(meta_item.magnet, function _addCallback(argument) {
          ircc.say(nick, '[ o ] ' + meta_item.season + 'x' + meta_item.episode + ': ' + meta_item.seeds + '/' + meta_item.peers + ' (' + meta_item.size + ')');
        });
      });
    });
    
  } else {
    logger.warn('Invalid command', text);
    return;
  }
});

/*
parseRSS(RSS_URL, function (err, feed) {
  if (err) {
    logger.error('Error getting RSS feed', err);
    return;
  }
  
  async.eachSeries(feed, function (item, next) {
    var interest
      ;
    
    INTERESTED.forEach(function (interest_) {
      if (interest) { return; }
      
      if (item.title.match(interest_)) {
        logger.ok('Found interesting item', item.title);
        interest = interest_;
      }
    });
    
    if (!interest) {
      logger.debug('Not interesting', item.title);
      next(null, null);
      return;
    }
    
    _getMeta({ title: item.title, originalTitle: item.title, subtitles: item.subtitles }, function (err, meta) {
      if (err) {
        next(err);
        return;
      }
      
      if (meta === null) {
        logger.warn('Skipping torrent file', item.title);
        return;
      }
      
      logger.debug('Got meta', meta);
      _addTx(meta.magnet, next);
    });
    
  }, function (err) {
    if (err) {
      throw err;
    }
    
    logger.log('Complete');
  });
});
*/

// Gets metadata by file name

function _getMeta(ret, next) {
  var parts = new RegExp(MACHINE.quality_re, 'ig').exec(ret.title);
      
  if (parts === null) {
    logger.warn('Torrent did not match regexp', ret.title);
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
          logger.error('Cannot get info_hash from web service (isEpisodeRange===true):', current.torrentSearch, first_result);
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
    
    logger.log('Req', TORRENTZ_URL.assign({ q: ret.torrentSearch.escapeURL(true) }));
    logger.debug('Parsed meta', ret);

    _searchAdd(ret.torrentSearch.escapeURL(true), function (_, first_result) {
      if (!first_result) {
        logger.error('Cannot get info_hash from web service (isEpisodeRange===false):', ret.torrentSearch, first_result);
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
  , headers: { 'Accept': '*/*', 'User-Agent': MACHINE.user_agent }
  }, function (err, _, body) {
    if (err) {
      logger.error('Torrent search error');
      cb(null, null);
      return;
    }
    
    var first_result = new RegExp(MACHINE.torrentz_re, 'im').exec(body);
    cb(null, first_result);
  });
}


// Add torrent to transmission

function _addTx(magnet, next) {
  transmission.add(magnet, function (err, tx_res) {
    if (err) {
      logger.error('Cannot add torrent to transmission', err);
      next(err, null);
      return;
    }
    
    if (tx_res && tx_res.id) {
      logger.ok('Downloading torrent', tx_res.hashString, 'with id', tx_res.id);
    } else {
      logger.warn('Cannot add torrent, maybe it is already in queue.');
    }
    
    next(null);
  });
}




// Query Transmission for torrents' status

async.forever(function _foreverLoop(again) {
  // @FIXME @TODO @BUG getting 'all' torrents (first param can be tx id list)
  transmission.get(function _txGetTorrentsInfoCallback(err, response) {
    if (err) {
      logger.error('_txGetTorrentsInfoCallback error', err);
      throw err;
    }
        
    async.each(response.torrents, function _eachIterator(torrent, next) {
      logger.log('Torrent', torrent.name, torrent.id);
      // Object.select(torrent, ['id', 'status', 'peersConnected', 'name', 'hashString', 'downloadDir', 'files', 'isFinished']));
      
      if (torrent.status === transmission.status.SEED || torrent.status === transmission.status.SEED_WAIT) {
        _cargo.push(torrent, function (err) {
          if (err) {
            next(err);
            return;
          }
          
          next();
        });
        
      } else {
        process.nextTick(next);
      }
    }, function _eachCallback(err) {
      if (err) {
        logger.error('_eachCallback error', err);
        throw err;
      }
            
      setTimeout(again, 60000);
    });
  });
  
}, function (err) {
  throw err;
});


// Upload files to MEGA

_cargo = async.cargo(function (tasks, done) {
  logger.debug('Cargo worker with', tasks.length, 'tasks...');
  
  async.eachSeries(tasks, function (tx_torrent, next) {
    logger.log('Torrent', tx_torrent.hashString, '#' + tx_torrent.id, 'is complete:');
    
    _mem.exists(tx_torrent.hashString, function (_, exists) {
      
      if (exists) {
        logger.log('\t-> and has been already uploaded');
        next();
        return;
      }
    
      if (_uploading.indexOf(tx_torrent.hashString) !== -1) {
        logger.log('\t-> upload is already in progress for this file.');
        next();
        return;
      }
      
      
      logger.log('Current uploads', _uploading);
      _uploading.push(tx_torrent.hashString);
      
      
      async.eachSeries(tx_torrent.files, function (file, innerNext) {
        var fileName = file.name
          , filePath = path.join(tx_torrent.downloadDir, fileName)
          ;
          
        logger.log('\t-> uploading file', fileName, '(from ' + filePath + ')');
        
        var stream = fs.createReadStream(filePath);
        stream.pipe(megaStorage.upload(fileName));
        
        fs.readFile(filePath, {}, function (err, contents) {
          if (err) {
            innerNext(err);
            return;
          }
          
          megaStorage.upload(fileName, contents, function (err, file) {
            if (err) {
              innerNext(err);
              return;
            }
            
            file.link(function (err, url) {
              if (err) {
                innerNext(err);
                return;
              }
              
              logger.ok('\t-> file upload compete', fileName, url);
              
              _mem.add(tx_torrent.hashString, [ fileName, url ].join(' '), function () {
                logger.log('\t-> file in memory :D');
                innerNext(null);
              });
            }); // link
          }); // upload
        }); // fs
      }, function (err) { // innerEach
        next(err);
      });
      
    }); // _mem.exists
    
  }, function (err) { 
    if (err) {
      logger.error('Serie batch error', err);
      done(err);
      return;
    }
    
    done();
  });
});

_cargo.payload = 1;

/*
var _sayWithUrl = suspend.async(function *(tx_torrent, url) {
  var torrent = yield store.get(tx_torrent);
  
  _irccsay(
    '' + torrent.originalTitle + ' (' + torrent.size + ')' + '\n' +
    'subs: ' + torrent.subtitles + '\n' +
    'dl: ' + url
  );
});*/

