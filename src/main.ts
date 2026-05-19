import 'dotenv/config'
import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger'
import { MikroORM } from '@mikro-orm/core'
import helmet from 'helmet'
import * as cookieParser from 'cookie-parser'
import { AppModule } from './app.module'
import { SitesService } from './sites/sites.service'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true })

  // Ensure the dedicated Postgres schema exists before any query runs.
  // Lets us safely share a database with sibling services (e.g. apotome-labs).
  const orm = app.get(MikroORM)
  const schema = process.env.DB_SCHEMA || 'archetype'
  await orm.em.getConnection().execute(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)

  app.use(helmet({ contentSecurityPolicy: false }))
  app.use(cookieParser())

  // Dynamic CORS: always-allow envvar + every live custom domain / vercel URL.
  const sites = app.get(SitesService)
  const allowList = (process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:4173').split(',').map(s => s.trim())
  app.enableCors({
    credentials: true,
    origin: async (origin, cb) => {
      if (!origin) return cb(null, true)
      if (allowList.includes(origin)) return cb(null, true)
      // All *.vercel.app preview/production URLs are always allowed — checked
      // here BEFORE the DB query so a database hiccup can't block valid origins.
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

