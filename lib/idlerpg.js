'use strict';

// IdleRPG's core dependencies
const Fabric = require('@fabric/core');

// Modules
const Encounter = require('./encounter');
const Entity = require('./entity');

// external libraries
const article = require('indefinite-article');
const manager = require('fast-json-patch');
const pointer = require('json-pointer');
const schedule = require('node-schedule');

// configuration globals
const PER_TICK_CAPITAL = 10;
const PER_TICK_EXPERIENCE = 10;
const TICK_INTERVAL = 600000;
const ENCOUNTER_CHANCE = 0.05;

/**
 * Implements a single-process instance of IdleRPG.
 * @property {Object} config Current configuration.
 * @property {Array} channels List of channels IdleRPG is watching.
 * @property {Fabric} fabric IdleRPG's event bus.
 * @property {Object} state Current game state.
 * @property {Observer} observer
 * @property {Array} triggers
 * @property {String} status
 */
class IdleRPG extends Fabric {
  /**
   * The main IdleRPG constructor.
   * @param       {Object} config Configuration object.
   * @param       {String} config.name Name of the game.
   * @param       {String} config.alias What should the agent call itself?
   * @param       {Array} config.channels List of channels to monitor.
   * @param       {Array} config.channels List of services to use.
   * @param       {Number} config.interval Tick interval (in milliseconds).
   * @param       {Number} config.luck How rare is an encounter?
   * @param       {Number} config.PER_TICK_CAPITAL
   * @param       {Number} config.PER_TICK_EXPERIENCE
   * @param       {String} config.store Location of the storage folder.
   */
  constructor (config) {
    // configure Fabric
    super(config);

    // set up defaults
    this.config = Object.assign({
      name: 'idlerpg',
      alias: '@idlerpg:verse.im',
      channels: ['idlerpg'],
      services: ['local'],
      interval: TICK_INTERVAL,
      luck: ENCOUNTER_CHANCE,
      PER_TICK_CAPITAL: PER_TICK_CAPITAL,
      PER_TICK_EXPERIENCE: PER_TICK_EXPERIENCE,
      store: './data/idlerpg'
    }, config);

    // maintain a list of interesting channels
    this.channels = [];

    // configure event machine
    this.fabric = new Fabric();

    // define behaviors
    this.triggers = [
      { name: 'online', value: this._handleOnlineRequest },
      { name: 'memberlist', value: this._handleMemberlistRequest },
      { name: 'play', value: this._handlePlayRequest },
      { name: 'profile', value: this._handleProfileRequest },
      { name: 'inventory', value: this._handleInventoryRequest },
      { name: 'leaderboard', value: this._handleLeaderboardRequest },
      { name: 'transfer', value: this._handleTransferRequest },
      { name: 'balance', value: this._handleBalanceRequest }
    ];

    // initialize a default state
    this.state['@data'] = {
      channels: {},
      players: {},
      services: {},
      users: {}
    };

    // watch local state for changes
    this.observer = manager.observe(this.state['@data']);

    // signal ready status
    this.status = 'ready';

    return this;
  }

  /**
   * Make an announcement.
   * @param  {String} message Text of the announcment message.
   * @return {IdleRPG}         Running instance of IdleRPG.
   */
  announce (message) {
    let rpg = this;
    for (let name in rpg.fabric.services) {
      for (let i in rpg.channels) {
        this.emit('message', {
          actor: this.actor,
          object: message,
          target: [name, 'channels', rpg.channels[i]].join('/')
        });
      }
    }
    return rpg;
  }

  /**
   * Clock frame.  Called once per cycle (tick).
   * @fires {IdleRPG#tick} Emitted once the clock cycle is complete.
   * @return {IdleRPG} Chainable method.
   */
  async tick () {
    this.log(`Beginning tick ${this.id}...`);

    let rpg = this;
    let players = await rpg._getActivePlayers().catch((E) => {
      rpg.error('[IDLERPG]', 'Could not get active players:', E);
    });

    // TODO: determine validity from signatures
    // sum all transaction signatures to achieve single-signature per block
    for (let i in players) {
      await rpg._computeRound(players[i]);
    }

    this.emit('tick');

    return rpg;
  }

  /**
   * Give a particular player a reward.
   * @param  {Player}  player Instance of player to reward.
   * @return {Promise}        Resolves on commit.
   */
  async reward (player) {
    let rpg = this;
    let prior = new Entity(player);
    let instance = await rpg._rollForEncounter(player);

    // if we got an encounter, apply results to our player
    if (instance) {
      Object.assign(player, instance);
    }

    // primary updates
    player.wealth = (player.wealth || 0) + PER_TICK_CAPITAL;
    player.experience = (player.experience || 0) + PER_TICK_EXPERIENCE;

    // sample the contents
    let sample = new Entity(player);

    // check if level has changed
    if (sample.level && sample.level > prior.level) {
      rpg.announce(`${player.name} has reached level ${sample.level}!`);
    }

    let target = pointer.escape(player.id);

    manager.applyPatch(rpg.state, [
      { op: 'replace', path: `/players/${target}`, value: player }
    ]);

    await rpg.commit();
  }

  /**
   * Pernalize a particular player for violating the rules.
   * @param  {Player}  player Instance of player to penalize.
   * @return {Promise}        Resolves on commit.
   */
  async penalize (player) {
    let notify = false;
    let target = pointer.escape(player.id);

    if (!player.cooldown || player.cooldown < 100) {
      notify = true;
    }

    player.cooldown = 1000;
    player.wealth = player.wealth * 0.5; // slashed!

    manager.applyPatch(this.state, [
      { op: 'replace', path: `/players/${target}/cooldown`, value: player.cooldown },
      { op: 'replace', path: `/players/${target}/wealth`, value: player.wealth }
    ]);

    await this.commit();

    if (notify) {
      this.announce(`${player.name} has disrupted the peace!  Penalties have been applied, but life goes on.`);
    }
  }

  /**
   * Entry point for running IdleRPG.  Creates a datastore, subscribes to events,
   * initializes the clock, and emits a "ready" event when complete.
   */
  async start () {
    let rpg = this;

    rpg.log('IdleRPG starting...');

    await super.start();

    // open the datastore
    await rpg.store.open().catch((E) => {
      throw new Error('Could not open store:', E);
    });

    // start Fabric
    await rpg.fabric.start().catch((E) => {
      throw new Error('Could not start Fabric:', E);
    });

    // restore historical state
    let state = await rpg._GET('/').catch((E) => {
      rpg.warn('Could not retrieve prior state (fresh start!):', E);
    });

    if (state) {
      try {
        let parsed = JSON.parse(state);
        let merged = Object.assign({}, rpg.state, parsed);
        rpg.state = merged;
      } catch (E) {
        rpg.error('Could not restore state:', E);
      }
    }

    rpg.fabric.on('join', rpg._handleJoin.bind(rpg));
    rpg.fabric.on('part', rpg._disjoinPlayer.bind(rpg));
    rpg.fabric.on('user', rpg._registerUser.bind(rpg));
    rpg.fabric.on('channel', rpg._registerChannel.bind(rpg));
    rpg.fabric.on('message', rpg._handleMessage.bind(rpg));
    rpg.fabric.on('service', rpg._registerService.bind(rpg));
    rpg.fabric.on('patch', rpg._handlePatch.bind(rpg));
    rpg.fabric.on('patches', rpg._handlePatches.bind(rpg));

    // console.log('Fabric services:', rpg.fabric.services);

    // create a Core for each Service
    for (let name in rpg.fabric.services) {
      rpg.fabric.services[name].once('ready', rpg._handleServiceReady.bind(rpg));
    }

    rpg.heartbeat = setInterval(function () {
      try {
        rpg.tick();
      } catch (E) {
        rpg.error('error ticking:', E);
      }
    }, this.config.interval);

    // TODO: document & test
    rpg.newsletter = schedule.scheduleJob('0 0 9 * * *', async function () {
      let leaderboard = await rpg._handleLeaderboardRequest();
      rpg.announce(`A rooster crows in the distance, signalling the break of dawn.  ${leaderboard}`);
    });

    if (rpg.config.debug) {
      setInterval(() => {
        rpg.log(rpg.state);
        rpg.log('^^^^^^^^^^ is the [IDLERPG] state');
      }, 10000);
    }

    rpg.emit('ready');

    return rpg;
  }

  async stop () {
    clearInterval(this.clock);
    // await this.fabric.stop();
    await super.stop();
    this.status = 'stopped';
    return this;
  }

  async _handleServiceReady (service) {
    let rpg = this;

    for (let i in rpg.config.channels) {
      let channel = rpg.config.channels[i];
      let members = await service._getMembers(channel).catch((E) => {
        rpg.error(`Couldn't get members for "${channel}":`, E);
      });

      if (members) {
        rpg.channels.push(channel);

        if (!members.includes(service.agent.id)) {
          await service.join(channel);
        }
      }
    }

    return rpg;
  }

  async _computeRound (player) {
    let rpg = this;

    rpg.log('computing round for:', player.id);

    let profile = await rpg._getProfile(player.id).catch(function (E) {
      rpg.error('Could not get profile:', E);
    });

    if (!profile) return false;

    // relax the cooldown...
    if (profile.cooldown) {
      profile.cooldown = profile.cooldown - rpg.config.PER_TICK_CAPITAL;
    }

    if (profile.presence === 'online') {
      await rpg.reward(profile);
    }

    return profile;
  }

  async _rollForEncounter (instance) {
    let rpg = this;
    let result = null;
    let player = Object.assign({}, instance);

    if (Math.random() < rpg.config.luck) {
      let encounter = new Encounter(player);

      result = Object.assign({}, player, encounter.entity);

      switch (encounter.type) {
        case 'blessing':
          rpg.announce(`${player.name} has been blessed by the Gods!  Good fortune lies ahead.`);
          break;
        case 'monster':
          // TODO: random phrasing
          rpg.announce(`${player.name} came upon a wild ${encounter.state.monster.name} in their adventures!  The fight raged on, but in the end ${player.name} prevailed. **${encounter.state.loot}** gold was looted from the dead corpse.`);
          break;
        case 'item':
          let claim = `${player.name} found a discarded ${encounter.state.item.name}`;
          if (encounter.state.equipped) {
            claim += `, which they have equipped as their main weapon.`;
          } else if (encounter.state.skipped) {
            claim += `, but discarded it as they were carrying too much already.`;
          } else {
            claim += `.  They now have **${player.inventory.length}** items in their inventory.`;
          }
          rpg.announce(claim);
          break;
      }
    }

    return result;
  }

  /**
   * Get a {@link Player} profile by ID.
   * @param  {String} id Player ID.
   * @return {Player}    Instance of the {@link Player} object.
   */
  async _getProfile (id) {
    let rpg = this;
    let parts = id.split('/');

    if (parts.length === 1) {
      parts = ['local', 'users', id];
    }

    let path = parts.join('/');
    let target = pointer.escape(path);

    let prior = null;

    try {
      // TODO: use Fabric._GET
      // prior = await rpg.fabric._GET(`/players/${target}`);
      prior = await rpg._GET(`/players/${target}`);
    } catch (E) {
      rpg.error('Exception thrown getting profile:', E);
    }

    rpg.log('getProfile got:', prior);

    let base = new Entity({ id: path });
    let data = Object.assign({}, base, prior);
    let profile = {
      id: data.id,
      name: data.name,
      type: 'Player',
      health: data.health || 100,
      stamina: data.stamina || 100,
      experience: data.experience || 0,
      equipment: Object.assign({}, data.equipment, {
        weapon: data.weapon || null
      }),
      inventory: data.inventory || [],
      presence: data.presence || 'offline',
      effects: data.effects || {},
      wealth: data.wealth || 0
    };

    return profile;
  }

  async _handleMessage (message) {
    this.log('idleRPG handling:', message);
    if (!this.channels.includes(message.target)) return;
    let profile = await this._getProfile(message.actor);
    await this.penalize(profile);
  }

  async _handlePlayRequest (message) {
    return `Join #idlerpg:verse.im to play.  Permalink: https://to.fabric.pub/#idlerpg:verse.im`;
  }

  async _handleProfileRequest (message) {
    let rpg = this;
    let profile = await rpg._getProfile(message.actor);
    let entity = new Entity(profile);
    let effects = Object.keys(entity.effects);
    let equipment = profile.equipment;
    let response = `You are level **${entity.level}** (having earned **${profile.experience}** experience), with **${profile.stamina}** stamina, **${profile.health}** health, and **${profile.wealth}** <small>IDLE</small> in wealth.`;

    if (equipment.weapon) {
      response += `  Your current weapon is ${article(equipment.weapon.name)} **${equipment.weapon.name}**, which has **${equipment.weapon.attack}** attack and **${equipment.weapon.durability}** durability.`;
    }

    if (effects.length) {
      response += `  You are currently ${effects[0]}.`;
    } else {
      response += `  No special statuses are currently applied.`;
    }

    return response;
  }

  async _handleInventoryRequest (message) {
    let rpg = this;
    let profile = await rpg._getProfile(message.actor);
    if (!profile.inventory.length) return `You have no items in your inventory.`;
    let response = `Your inventory:`;

    for (let i in profile.inventory) {
      let item = profile.inventory[i];
      response += `\n- ${article(item.name)} **${item.name}**, with **${item.attack}** attack and **${item.durability}** durability`;
    }

    return response;
  }

  async _handleBalanceRequest (message) {
    let rpg = this;
    let profile = await rpg._getProfile(message.actor);
    let response = `Your current balance is **${profile.wealth}** <small>IDLE</small>.  You can use \`!transfer <amount> <user>\` to transfer an amount to another user by ID (i.e., \`@eric:ericmartindale.com\`)`;
    return response;
  }

  async _handleTransferRequest (message) {
    let rpg = this;

    if (!message.object) return `Transfer message must have property "object".`;
    if (!message.actor) return `Transfer message must have property "actor".`;
    if (!(typeof message.object === 'string')) return `Transfer message property "object" must be a string.`;
    if (!(typeof message.actor === 'string')) return `Transfer message property "actor" must be a string.`;

    let parts = (message.object).split(' ');

    if (parts.length !== 3) return `Command format: \`!transfer <amount> <user>\``;
    if (message.actor.split('/')[2] === parts[2]) return `You cannot transfer money to yourself.`;

    let actor = await rpg._getProfile(message.actor);
    let target = await rpg._getProfile(`${message.origin.name}/users/${parts[2]}`);
    let amount = parseInt(parts[1]);
    // TODO: handle memo

    let actorID = pointer.escape(actor.id);
    let targetID = pointer.escape(target.id);

    if (!target) return `Couldn't find ${message.target}`;
    if (!actor.wealth) return `You have no wealth to transfer.`;
    if (parseInt(actor.wealth - amount) < 0) return `You do not have that amount.  You'll need **${parseInt(actor.wealth - amount)}** more <small>IDLE</small> to proceed with this transfer.`;

    await rpg._registerPlayer(actor);
    await rpg._registerPlayer(target);

    try {
      // TODO: FUSE filesystem
      let ops = [
        {
          op: 'replace',
          path: `/players/${actorID}/wealth`,
          value: parseInt(actor.wealth) - parseInt(amount)
        },
        {
          op: 'replace',
          path: `/players/${targetID}/wealth`,
          value: parseInt(target.wealth) + parseInt(amount)
        }
      ];

      manager.applyPatch(rpg.state, ops);
    } catch (E) {
      rpg.error('[IDLERPG]', 'could not serialize transaction:', E);
      return `Could not complete your transfer request at this time: ${E}`;
    }

    await rpg.commit();

    rpg.emit('whisper', {
      target: target.id,
      message: `${actor.name} (${actor.id}) has transferred **${amount}** <small>IDLE</small> to your account!  You can check your balance now with a \`!balance\` inquiry.`
    });

    return `Balance transferred successfully!`;
  }

  async _handleOnlineRequest () {
    let rpg = this;
    let list = await rpg._getActivePlayers();
    let online = list.map(x => x.name);
    return `Current online members for the \`idlerpg\` plugin:\n\n\`\`\`\n${JSON.stringify(online, null, '  ')}\n\`\`\``;
  }

  async _handleMemberlistRequest () {
    let rpg = this;
    let list = await rpg._getPlayers();
    let members = list.map(x => x.name);

    return `Current memberlist for the \`idlerpg\` plugin:\n\n\`\`\`\n${JSON.stringify(members, null, '  ')}\n\`\`\``;
  }

  async _handleLeaderboardRequest () {
    let rpg = this;
    let list = await rpg._getPlayers();

    list.sort(function (a, b) {
      return b.experience - a.experience;
    });

    let members = list.map(x => {
      return `1. ${x.name}, with **${x.experience}** experience`;
    }).slice(0, 10);

    rpg.log('leaderboard list:', list);
    rpg.log('leaderboard members:', members);

    try {
      rpg._PUT('/leaderboard', members);
    } catch (E) {
      rpg.error('Could not save leaderboard:', E);
    }

    return `Leaderboard:\n${members.join('\n')}`;
  }

  /**
   * Gets an up-to-date list of all IdleRPG players.
   * @return {Array} List of players.
   */
  async _getPlayers () {
    let rpg = this;
    let players = [];

    for (let name in rpg.fabric.services) {
      let service = rpg.fabric.services[name];
      for (let i in rpg.channels) {
        let members = await service._getMembers(rpg.channels[i]).catch((E) => {
          rpg.log('[IDLERPG]', `Could not retrieve members of "${i}":`, E);
        });

        for (let j in members) {
          if (members[j] === service.agent.id) return;
          let path = [name, 'users', members[j]].join('/');
          let profile = await rpg._getProfile(path).catch(rpg.error);
          let player = await rpg._registerPlayer(profile).catch(rpg.error);

          if (player) {
            player.presence = await service._getPresence(members[j]).catch(rpg.error);
            players.push(player);
          }
        }
      }
    }

    return players;
  }

  /**
   * Gets a list of all "currently active" IdleRPG players.
   * @return {Array} List of players.
   */
  async _getActivePlayers () {
    let rpg = this;
    let players = await rpg._getPlayers();
    let online = players.filter(x => (x.presence === 'online'));

    return online.filter(function (x) {
      // TODO: configurable exclude of self
      return x.alias !== rpg.config.alias;
    });
  }

  async _handleJoin (join) {
    if (this.config.debug) this.log('[IDLERPG]', 'handling join:', join);

    await this._registerChannel({
      id: join.channel,
      name: join.channel
    });

    let parts = join.channel.split('/');

    if (parts.length === 1) parts = ['local', 'channels', join.channel];
    if (this.channels.includes(parts[2])) {
      let chunks = join.user.split('/');
      if (chunks.length === 1) chunks = ['local', 'users', join.user];
      let player = await this._registerPlayer({ id: join.user });
      await this._welcomePlayer(player);
    }
  }

  async _welcomePlayer (player) {
    this.announce(`Welcome to [IdleRPG](https://github.com/FabricLabs/idlerpg-bot), ${player.name}.  The one rule — _no talking in this channel_ — is now in effect.  **Violators will be slashed.**   Message [@idlerpg](https://matrix.to/#/@idlerpg:verse.im) _directly_ for [\`!help\`](https://github.com/FabricLabs/idlerpg-bot#triggers) or just enjoy the ride.  Best of luck!`);
  }

  async _registerPlayer (player) {
    if (!player.id) return this.error('Player must have an "id" property.');

    let rpg = this;
    let parts = player.id.split('/');

    if (parts.length === 1) {
      parts = ['local', 'users', player];
    }

    let id = [parts[0], 'users', parts[2]].join('/');
    let target = pointer.escape(id);
    let path = `/players/${target}`;
    let data = Object.assign({}, player);

    try {
      manager.applyPatch(rpg.state, [{
        op: 'replace',
        path: path,
        value: data
      }]);
    } catch (E) {
      rpg.error('cannot apply patch:', E);
    }

    await rpg.commit();

    let profile = rpg._GET(`/players/${target}`);

    return profile;
  }

  async _disjoinPlayer (player) {
    let rpg = this;

    try {
      await rpg._registerPlayer(player);
    } catch (E) {
      return rpg.error('Could not disjoin player:', E);
    }

    let id = pointer.escape(player.id);
    let path = `/players/${id}/presence`;

    try {
      manager.applyPatch(rpg.state['@data'], [{
        op: 'replace',
        path: path,
        value: 'offline'
      }]);
    } catch (E) {
      return rpg.error('cannot apply patch:', E);
    }

    await rpg.commit();

    return this;
  }

  /**
   * Takes a {@link User} object and registers it as a player.
   * @param  {User} user User to register as a Player.
   * @return {Player}      Instance of the Player object.
   */
  async _registerUser (user) {
    if (!user.id) return this.error('User must have an "id" property.');
    if (!user.name) return this.error('User must have a "name" property.');

    let rpg = this;
    let parts = user.id.split('/');

    if (parts.length === 1) {
      parts = ['local', 'users', user.id];
    }

    let id = parts.join('/');
    let target = pointer.escape(id);
    let path = `/users/${target}`;
    let profile = await rpg._getProfile(id);

    try {
      manager.applyPatch(rpg.state, [{
        op: 'replace',
        path: path,
        value: profile
      }]);
    } catch (E) {
      rpg.error('cannot apply patch:', E);
    }

    // save to disk
    await rpg.commit();

    return rpg._GET(path);
  }

  async _registerChannel (channel) {
    if (!channel.id) return this.error('Channel must have an "id" property.');

    let rpg = this;
    let parts = channel.id.split('/');

    if (parts.length === 1) {
      parts = ['local', 'channels', channel.id];
    }

    let id = parts.join('/');
    let target = pointer.escape(id);
    let path = `/channels/${target}`;
    let data = Object.assign({
      id: id,
      name: channel.name || id,
      members: []
    }/*, channel */);

    try {
      manager.applyPatch(rpg.state, [{ op: 'replace', path: path, value: data }]);
    } catch (E) {
      rpg.error('cannot apply patch:', E);
    }

    await this.commit();

    return rpg._GET(path);
  }

  async _registerService (service) {
    manager.applyPatch(this.state, [{
      op: 'add',
      path: `/services/${service.name}`,
      value: {
        users: {},
        channels: {}
      }
    }]);
    await this.commit();
  }

  async _handlePatch (patch) {
    this.log('[IDLERPG]', 'handling patch:', patch);
    manager.applyOperation(this.state, patch);
    await this.commit();
  }

  async _handlePatches (patches) {
    this.log('[IDLERPG]', 'handling patches:', patches);
    manager.applyPatches(this.state, patches);
    await this.commit();
  }
}

module.exports = IdleRPG;
