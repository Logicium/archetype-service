import 'dotenv/config'
import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import { NestExpressApplication } from '@nestjs/platform-express'
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger'
import { MikroORM } from '@mikro-orm/core'
import helmet from 'helmet'
import * as cookieParser from 'cookie-parser'
import { AppModule } from './app.module'
import { SitesService } from './sites/sites.service'

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true })

  // Ensure the dedicated Postgres schema exists before any query runs.
  // Lets us safely share a database with sibling services (e.g. apotome-labs).
  const orm = app.get(MikroORM)
  const schema = process.env.DB_SCHEMA || 'archetype'
  await orm.em.getConnection().execute(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)

  // Idempotent column adds for entity fields introduced after initial schema
  // create. Cheap on every boot, avoids needing a full migration runner.
  await orm.em.getConnection().execute(`
    ALTER TABLE "${schema}"."site" ADD COLUMN IF NOT EXISTS "screenshot_url" varchar(255) NULL;
    ALTER TABLE "${schema}"."site" ADD COLUMN IF NOT EXISTS "screenshot_captured_at" timestamptz NULL;
    ALTER TABLE "${schema}"."site" ADD COLUMN IF NOT EXISTS "screenshot_source_url" varchar(255) NULL;
  `)

  app.use(helmet({ contentSecurityPolicy: false }))
  app.use(cookieParser())

  // Image uploads from the admin panel send base64-encoded photos in JSON.
  // The default 100kb limit rejects anything larger than a thumbnail.
  app.useBodyParser('json', { limit: '25mb' })
  app.useBodyParser('urlencoded', { limit: '25mb', extended: true })

  // Dynamic CORS: always-allow envvar + every live custom domain / vercel URL.
  const sites = app.get(SitesService)
  const allowList = (process.env.CORS_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
  app.enableCors({
    credentials: true,
    origin: async (origin, cb) => {
      if (!origin) return cb(null, true)
      // Allow all localhost origins regardless of port (local dev only).
      if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true)
      if (allowList.includes(origin)) return cb(null, true)
      // Always allow any Vercel preview/production URL regardless of DB state
      if (origin.endsWith('.vercel.app')) return cb(null, true)
      try {
        const dyn = await sites.allLiveOrigins()
        if (dyn.includes(origin)) return cb(null, true)
      } catch { /* ignore */ }
      cb(new Error(`Origin not allowed: ${origin}`), false)
    },
  })

  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))

  const config = new DocumentBuilder()
    .setTitle('Apotome Archetype Service')
    .setDescription('Backend platform for the Apotome Archetypes program.')
    .setVersion('0.1.0')
    .build()
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config))

  const port = parseInt(process.env.PORT || '3001', 10)
  await app.listen(port)
  console.log(`archetype-service listening on http://localhost:${port}`)
}
bootstrap()

