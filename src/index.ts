import express from 'express'
import dotenv from 'dotenv'
import mysql from 'mysql2/promise'
import fetch from 'node-fetch'
import { LoggerFactory } from 'logger.js'
import { InteractionType, verifyKeyMiddleware } from 'discord-interactions'
import { RowDataPacket } from 'mysql2'

dotenv.config()

const logger = LoggerFactory.getLogger('main', null)
const app = express()

const clientId = Buffer.from(
  process.env.BOT_TOKEN!.split('.')[0],
  'base64'
).toString('ascii')

!(async () => {
  const pool = mysql.createPool({
    host: process.env.MARIADB_HOST,
    database: process.env.MARIADB_NAME,
    user: process.env.MARIADB_USERNAME,
    password: process.env.MARIADB_PASSWORD,
    ssl: process.env.MARIADB_SSL || undefined,
    waitForConnections: true,
  })

  await pool.query(`
    CREATE TABLE IF NOT EXISTS \`allowed_users\` (
      \`id\` VARCHAR(64) NOT NULL,
      \`allowed_servers\` TEXT NOT NULL DEFAULT "",
      PRIMARY KEY(\`id\`)
    )
  `)

  app.get('/', (req, res) => {
    res.redirect(
      `https://discord.com/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(
        process.env.REDIRECT_URI || ''
      )}&response_type=code&scope=guilds.join%20identify`
    )
  })

  app.get('/callback', async (req, res) => {
    const code = String(req.query.code)
    if (!code) {
      return res.status(400).send({ error: 'invalid request' })
    }
    const tokenResponse = (await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.CLIENT_ID || '',
        client_secret: process.env.CLIENT_SECRET || '',
        grant_type: 'authorization_code',
        redirect_uri: process.env.REDIRECT_URI || '',
        scope: 'identity guilds.join',
      }).toString(),
    }).then((res) => res.json())) as DiscordAPIResponse<DiscordTokenResponse>
    if ((tokenResponse as DiscordAPIError).error) {
      return res.status(401).send({ error: 'unauthorized' })
    }
    const token = tokenResponse as DiscordTokenResponse
    const userResponse = (await fetch('https://discord.com/api/users/@me', {
      headers: {
        Authorization: `${token.token_type} ${token.access_token}`,
      },
    }).then((res) => res.json())) as DiscordAPIResponse<DiscordUser>
    if ((userResponse as DiscordAPIError).error) {
      return res.status(401).send({ error: 'unauthorized' })
    }
    const user = userResponse as DiscordUser
    const allowedServersResult = (
      await pool.query(
        'SELECT `allowed_servers` FROM `allowed_users` WHERE `id` = ? LIMIT 1',
        user.id
      )
    )[0] as mysql.RowDataPacket[]
    if (allowedServersResult.length === 0) {
      return res.status(401).send({ error: 'unauthorized' })
    }
    const allowedServers = allowedServersResult[0].allowed_servers as string
    for (const serverId of allowedServers.split(',')) {
      const result = await fetch(
        `https://discord.com/api/guilds/${serverId}/members/${user.id}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bot ${process.env.BOT_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            access_token: token.access_token,
          }),
        }
      ).then((res) => res.text())
      logger.info(`Join result of ${user.id} to ${serverId}: ${result}`)
    }
    res.redirect(
      `https://discord.com/channels/${allowedServers.split('\n')[0]}`
    )
  })

  app.post(
    '/interactions',
    verifyKeyMiddleware(process.env.APPLICATION_PUBLIC_KEY || ''),
    async (req, res) => {
      const interaction = req.body
      if (
        (interaction.data.name === 'gate-add' ||
          interaction.data.name === 'gate-update' ||
          interaction.data.name === 'gate-remove' ||
          interaction.data.name === 'gate-clear') &&
        interaction.type === InteractionType.APPLICATION_COMMAND
      ) {
        const user = interaction.data.options.find(
          (e: any) => e.name === 'user'
        ).value as string
        if (!/^\d+$/.test(user)) {
          return res.send({
            type: 4,
            data: {
              content: `\`${user}\`はユーザーIDではありません。`,
            },
          })
        }
        if (interaction.data.name === 'gate-update') {
          const allowedServers = interaction.data.options.find(
            (e: any) => e.name === 'allowed-servers'
          ).value as string
          if (!/^\d+(?:,\d+)*$/.test(allowedServers)) {
            return res.send({
              type: 4,
              data: {
                content: 'サーバーIDは半角数字とカンマで区切ってください。',
              },
            })
          }
          await pool.query(
            'INSERT INTO `allowed_users` (`id`, `allowed_servers`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `allowed_servers` = VALUES(`allowed_servers`)',
            [user, allowedServers]
          )
          const url = `https://discord.com/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(
            process.env.REDIRECT_URI || ''
          )}&response_type=code&scope=guilds.join%20identify`
          return res.send({
            type: 4,
            data: {
              content: `ユーザー\`${user}\`を追加しました。下のURLをコピーして送信してください。\n${url}`,
            },
          })
        }
        if (interaction.data.name === 'gate-add') {
          if (!interaction.guild_id) {
            return res.send({
              type: 4,
              data: {
                content: 'ここでは使用できません。',
              },
            })
          }
          // fetch current servers
          const result = (
            await pool.query(
              'SELECT `allowed_servers` FROM `allowed_users` WHERE `id` = ? LIMIT 1',
              user
            )
          )[0] as RowDataPacket[]
          const allowedServers =
            result.length > 0
              ? (result[0]['allowed_servers'] as string).split(',')
              : []
          // add server
          allowedServers.push(interaction.guild_id)
          allowedServers.filter((e, i, a) => a.indexOf(e) === i)
          logger.info(
            `Added ${interaction.guild_id}, new allowed servers: ${allowedServers}`
          )
          // modify database
          await pool.query(
            'INSERT INTO `allowed_users` (`id`, `allowed_servers`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `allowed_servers` = VALUES(`allowed_servers`)',
            [user, allowedServers.join(',')]
          )
          const url = `https://discord.com/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(
            process.env.REDIRECT_URI || ''
          )}&response_type=code&scope=guilds.join%20identify`
          return res.send({
            type: 4,
            data: {
              content: `ユーザー\`${user}\`を追加しました。下のURLをコピーして送信してください。\n${url}`,
            },
          })
        }
        if (interaction.data.name === 'gate-remove') {
          if (!interaction.guild_id) {
            return res.send({
              type: 4,
              data: {
                content: 'ここでは使用できません。',
              },
            })
          }
          // fetch current servers
          const result = (
            await pool.query(
              'SELECT `allowed_servers` FROM `allowed_users` WHERE `id` = ? LIMIT 1',
              user
            )
          )[0] as RowDataPacket[]
          let allowedServers =
            result.length > 0
              ? (result[0]['allowed_servers'] as string).split(',')
              : []
          // remove server
          allowedServers = allowedServers.filter(
            (e) => e !== interaction.guild_id
          )
          logger.info(
            `Removed ${interaction.guild_id}, new allowed servers: ${allowedServers}`
          )
          // modify database
          if (allowedServers.length === 0) {
            await pool.query('DELETE FROM `allowed_users` WHERE `id` = ?', user)
          } else {
            await pool.query(
              'INSERT INTO `allowed_users` (`id`, `allowed_servers`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `allowed_servers` = VALUES(`allowed_servers`)',
              [user, allowedServers.join(',')]
            )
          }
          return res.send({
            type: 4,
            data: {
              content: `ユーザー\`${user}\`をこのサーバーに参加できなくしました。`,
            },
          })
        }
        if (interaction.data.name === 'gate-clear') {
          await pool.query('DELETE FROM `allowed_users` WHERE `id` = ?', user)
          return res.send({
            type: 4,
            data: {
              content: `ユーザー\`${user}\`を削除しました。`,
            },
          })
        }
      }
      res.status(400).send({ error: 'bad request' })
    }
  )

  const pushCommand = async (command: any) => {
    await fetch(
      `https://discord.com/api/v10/applications/${clientId}/commands`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${process.env.BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(command),
      }
    ).then(async (res) => {
      logger.info('POST commands result: ' + (await res.text()))
    })
  }

  await pushCommand({
    type: 1, // slash command
    name: 'gate-add',
    description: 'Add this server to allowed server list of an user',
    options: [
      {
        type: 3, // string
        name: 'user',
        description: 'User ID',
        required: true,
      },
    ],
  })

  await pushCommand({
    type: 1,
    name: 'gate-update',
    description: 'Add or update an user',
    options: [
      {
        type: 3, // string
        name: 'user',
        description: 'User ID',
        required: true,
      },
      {
        type: 3, // string
        name: 'allowed-servers',
        description: 'Comma separated list of servers that the user can join',
        required: true,
      },
    ],
  })

  await pushCommand({
    type: 1, // subcommand
    name: 'gate-remove',
    description: 'Remove current guild from allowed server list of an user',
    options: [
      {
        type: 3, // string
        name: 'user',
        description: 'User ID',
        required: true,
      },
    ],
  })

  await pushCommand({
    type: 1, // subcommand
    name: 'gate-clear',
    description: 'Remove an ENTIRE user',
    options: [
      {
        type: 3, // string
        name: 'user',
        description: 'User ID',
        required: true,
      },
    ],
  })

  app.listen(process.env.PORT || 8080)
  logger.info('Listening on ' + (process.env.PORT || 8080))
})()
