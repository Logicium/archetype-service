import { Options, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { TsMorphMetadataProvider } from '@mikro-orm/reflection';
import { Migrator } from '@mikro-orm/migrations';
import 'dotenv/config';

/**
 * Postgres schema used by the archetype-service. All entities + the
 * migrations table live here so the service can safely share a database
 * with sibling services (e.g. apotome-labs-service in `public`).
 *
 * Override via `DB_SCHEMA` env var if you need to isolate further
 * (per-environment, per-tenant, etc.).
 */
const SCHEMA = process.env.DB_SCHEMA || 'archetype';

const config: Options = {
  driver: PostgreSqlDriver,
  clientUrl: process.env.DATABASE_URL,
  schema: SCHEMA,
  extensions: [Migrator],
  entities: ['dist/**/*.entity.js'],
  entitiesTs: ['src/**/*.entity.ts'],
  metadataProvider: TsMorphMetadataProvider,
  debug: process.env.NODE_ENV === 'development',
  driverOptions: {
    connection: { ssl: process.env.DATABASE_SSL !== 'false' },
  },
  migrations: {
    dropTables: false,
    path: './src/migrations',
    tableName: 'mikro_orm_migrations',
  },
};

export default config;
