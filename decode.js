
var irrelevant = require('irrelevant')
  , fs = require('fs')
  , readline = require('readline')
  ;

var book = fs.readFileSync('config/book.txt', { encoding: 'utf8' });
var rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});


rl.on('line', function (line) {
  rl.write(irrelevant.decode(line, book));
});

rl.prompt();
