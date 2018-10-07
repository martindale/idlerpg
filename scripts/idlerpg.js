#!/usr/bin/env node
'use strict';

const Core = require('../lib/core');

async function main () {
  let core = new Core({
    verbose: true,
    interval: 1000
  });
  return core.start();
}

module.exports = main();
