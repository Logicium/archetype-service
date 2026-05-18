import { Injectable, Logger, UnauthorizedException, BadRequestException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { EntityManager } from '@mikro-orm/postgresql'
import { InjectRepository } from '@mikro-orm/nestjs'
import { EntityRepository } from '@mikro-orm/postgresql'
import { createHash, randomBytes, scrypt as _scrypt, timingSafeEqual } from 'crypto'
import { promisify } from 'util'
import { Owner } from '../entities/owner.entity'
import { EmailService } from '../common/email.service'

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>
const MAGIC_LINK_TTL_MIN = 15
const SCRYPT_LEN = 64
const MIN_PASSWORD_LEN = 8

async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16)
  const buf = await scrypt(plain, salt, SCRYPT_LEN)
  return `scrypt$${salt.toString('hex')}$${buf.toString('hex')}`
}

async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$')
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(hashHex, 'hex')
  const got = await scrypt(plain, salt, expected.length)
  return got.length === expected.length && timingSafeEqual(got, expected)
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name)

  constructor(
    @InjectRepository(Owner) private readonly owners: EntityRepository<Owner>,
    private readonly em: EntityManager,
    private readonly jwt: JwtService,
    private readonly email: EmailService,
  ) {}

  async requestMagicLink(email: string, name?: string) {
    const lower = email.toLowerCase().trim()
    let owner = await this.owners.findOne({ email: lower })
    if (!owner) {
      owner = this.owners.create({ email: lower, name })
    } else if (name && !owner.name) {
      owner.name = name
    }

    const raw = randomBytes(32).toString('hex')
    owner.magicLinkHash = createHash('sha256').update(raw).digest('hex')
    owner.magicLinkExpiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MIN * 60_000)
    await this.em.persistAndFlush(owner)

    const token = this.jwt.sign({ sub: owner.id, kind: 'magic', raw }, { expiresIn: `${MAGIC_LINK_TTL_MIN}m` })
    const base = process.env.PUBLIC_BASE_URL || 'http://localhost:3001'
    const link = `${base}/v1/auth/callback?token=${encodeURIComponent(token)}`

    await this.email.send({
      to: owner.email,
      subject: 'Your Apotome Archetypes sign-in link',
      html: `<p>Hi${owner.name ? ' ' + owner.name : ''},</p>
        <p>Click below to sign in to your site dashboard. The link expires in ${MAGIC_LINK_TTL_MIN} minutes and works once.</p>
        <p><a href="${link}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;border-radius:6px;text-decoration:none">Sign in</a></p>
        <p style="color:#666;font-size:12px">If you didn't request this, you can safely ignore it.</p>`,
    })
    this.logger.log(`Magic link emailed to ${owner.email}`)
    return owner
  }

  async consumeMagicLink(token: string) {
    let payload: { sub: string; kind: string; raw: string }
    try {
      payload = this.jwt.verify(token)
    } catch {
      throw new UnauthorizedException('Invalid or expired token')
    }
    if (payload.kind !== 'magic') throw new UnauthorizedException('Bad token kind')

    const owner = await this.owners.findOne({ id: payload.sub })
    if (!owner) throw new UnauthorizedException('Unknown owner')
    const hash = createHash('sha256').update(payload.raw).digest('hex')
    if (owner.magicLinkHash !== hash || !owner.magicLinkExpiresAt || owner.magicLinkExpiresAt < new Date()) {
      throw new UnauthorizedException('Token already used or expired')
    }

    owner.magicLinkHash = undefined
    owner.magicLinkExpiresAt = undefined
    owner.lastLoginAt = new Date()
    await this.em.persistAndFlush(owner)

    const sessionToken = this.jwt.sign({ sub: owner.id, kind: 'session' }, { expiresIn: '30d' })
    return { token: sessionToken, owner: { id: owner.id, email: owner.email, name: owner.name } }
  }

  async verifySession(token: string): Promise<Owner | null> {
    try {
      const payload = this.jwt.verify(token) as { sub: string; kind: string }
      if (payload.kind !== 'session') return null
      return this.owners.findOne({ id: payload.sub })
    } catch {
      return null
    }
  }

  // ── Password auth ──────────────────────────────────────────────────────────

  /** Issue a 30-day session JWT for an owner. */
  mintSession(owner: Owner): string {
    return this.jwt.sign({ sub: owner.id, kind: 'session' }, { expiresIn: '30d' })
  }

  /** Register a new owner with email + password, or attach a password to an existing owner.
   *  Returns a session token + the owner. */
  async registerWithPassword(email: string, password: string, name?: string) {
    if (password.length < MIN_PASSWORD_LEN) {
      throw new BadRequestException(`Password must be at least ${MIN_PASSWORD_LEN} characters.`)
    }
    const lower = email.toLowerCase().trim()
    let owner = await this.owners.findOne({ email: lower })
    if (!owner) {
      owner = this.owners.create({ email: lower, name })
    } else if (owner.passwordHash) {
      throw new BadRequestException('An account with that email already has a password. Use sign-in.')
    } else if (name && !owner.name) {
      owner.name = name
    }
    owner.passwordHash = await hashPassword(password)
    owner.lastLoginAt = new Date()
    await this.em.persistAndFlush(owner)
    return { token: this.mintSession(owner), owner }
  }

  async loginWithPassword(email: string, password: string) {
    const lower = email.toLowerCase().trim()
    const owner = await this.owners.findOne({ email: lower })
    if (!owner || !owner.passwordHash) {
      throw new UnauthorizedException('Invalid email or password')
    }
    const ok = await verifyPassword(password, owner.passwordHash)
    if (!ok) throw new UnauthorizedException('Invalid email or password')
    owner.lastLoginAt = new Date()
    await this.em.persistAndFlush(owner)
    return { token: this.mintSession(owner), owner }
  }

  /** Set (or replace) the password for an already-authenticated owner. */
  async setPassword(owner: Owner, password: string) {
    if (password.length < MIN_PASSWORD_LEN) {
      throw new BadRequestException(`Password must be at least ${MIN_PASSWORD_LEN} characters.`)
    }
    owner.passwordHash = await hashPassword(password)
    await this.em.persistAndFlush(owner)
    return { ok: true as const }
  }
}
