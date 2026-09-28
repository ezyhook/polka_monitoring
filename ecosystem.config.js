'use strict';

/**
 * PM2 ecosystem file for Polkadot Validator Monitor
 *
 * Usage:
 *   pm2 start ecosystem.config.js      # start the bot
 *   pm2 start ecosystem.config.js --only polkamon   # start only the bot
 *   pm2 save                            # persist process list across reboots
 *   pm2 startup                         # generate init.d / systemd startup hook
 */

module.exports = {
  apps: [
    {
      name: 'polkamon',
      script: 'index.js',
      cwd: __dirname,

      // Restart settings
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,       // 5s between restarts
      min_uptime: '20s',         // must run ≥20s to count as a successful start

      // Environment — PM2 will merge these with the process environment;
      // secrets still go in .env (loaded by dotenv inside index.js)
      env: {
        NODE_ENV: 'production',
      },

      // Log rotation
      out_file: './logs/bot-out.log',
      error_file: './logs/bot-err.log',
      merge_logs: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_size: '50M',
      retain: 7,

      // Process settings
      node_args: '--max-old-space-size=512',
    },
  ],
};
