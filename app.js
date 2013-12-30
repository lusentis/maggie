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
  , root = null
  , _cargo
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
    return;
  }
  
  if (!root && text === 'I am root') {
    root = nick;
    ircc.say(nick, '' + nick + ' has been granted admin privileges.');
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
        logger.error('Error getting meta', err);
        return;
      }
      
      if (meta === null) {
        logger.warn('Skipping torrent file because meta is undefined', title);
        return;
      }
      
      logger.debug('Got meta', title, meta);
      _addTx(meta.magnet, function _addCallback(argument) {
        ircc.say('(.)');
      });
    });
    
  } else {
    logger.warn('Invalid command', text);
    return;
  }
});


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


// Gets metadata by file name

function _getMeta(ret, next) {
  var parts = new RegExp(MACHINE.quality_re, 'ig').exec(ret.title);
      
  if (parts === null) {
    logger.warn('Torrent did not match regexp', ret.title);
    next(null, null);
    return;
  }

  ret.title = parts[1];
  ret.season = parseInt(parts[2], 10);
  ret.episode = parseInt(parts[3], 10);
  ret.episodeSpecial = parts[4] || '';
  ret.quality = parts[5] || '';
  ret.extra = parts[6] || '';
  ret.torrentSearch = [
    ret.title, ' ',
    's' + ((ret.season < 10) ? '0' + ret.season : ret.season),
    'e' + ((ret.episode < 10) ? '0' + ret.episode : ret.episode) + ret.episodeSpecial,
    ' ', ret.quality, ret.extra
  ].join('').trim();

  logger.log('Req', TORRENTZ_URL.assign({ q: ret.torrentSearch.escapeURL(true) }));

  request({
    url: TORRENTZ_URL.assign({ q: ret.torrentSearch.escapeURL(true) })
  , strictSSL: true
  , headers: { 'Accept': '*/*', 'User-Agent': MACHINE.user_agent }
  }, function (err, _, body) {
    if (err) {
      logger.error('Torrent search error');
      next(null, null);
      return;
    }
    
    var first_result = new RegExp(MACHINE.torrentz_re, 'im').exec(body);
    if (!first_result) {
      logger.error('Cannot get info_hash from web service.');
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
      logger.log('Torrent', Object.select(torrent, ['id', 'status', 'peersConnected', 'name', 'hashString', 'downloadDir', 'files', 'isFinished']));
      
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
            
      setTimeout(again, 5000);
    });
  });
  
}, function (err) {
  throw err;
});


// Upload files to MEGA

_cargo = async.cargo(function (tasks, done) {
  logger.debug('Cargo worker with', tasks.length, 'tasks...');
  
  async.eachSeries(tasks, function (tx_torrent, next) {
    var fileName = tx_torrent.files[0].name
      , filePath = path.join(tx_torrent.downloadDir, fileName)
      ;
      
    logger.log('Torrent', tx_torrent.id, 'is complete.');
    logger.log('Uploading file', fileName, '(from ' + filePath + ')');
    
    var stream = fs.createReadStream(filePath);
    stream.pipe(megaStorage.upload(fileName));
    
    fs.readFile(filePath, {}, function (err, contents) {
      if (err) {
        next(err);
        return;
      }
      
      megaStorage.upload(fileName, contents, function (err, file) {
        if (err) {
          next(err);
          return;
        }
        
        file.link(function (err, url) {
          if (err) {
            next(err);
            return;
          }
          
          //_sayWithUrl(tx_torrent);
          _irccsay(url);
          
          logger.ok('Mega upload compete', url);
          next();
        });
      });
    });
    
  }, done);
  
}, 1);

/*
var _sayWithUrl = suspend.async(function *(tx_torrent, url) {
  var torrent = yield store.get(tx_torrent);
  
  _irccsay(
    '' + torrent.originalTitle + ' (' + torrent.size + ')' + '\n' +
    'subs: ' + torrent.subtitles + '\n' +
    'dl: ' + url
  );
});*/

