import { Body, Controller, Get, Post, Query, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common'
import type { Request, Response } from 'express'
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator'
import { ApiTags } from '@nestjs/swagger'
import { AuthService } from './auth.service'
import { JwtAuthGuard, AuthRequest } from './jwt.guard'

class RequestLinkDto {
  @IsEmail() email!: string
  @IsOptional() @IsString() name?: string
}

class PasswordRegisterDto {
  @IsEmail() email!: string
  @IsString() @MinLength(8) password!: string
  @IsOptional() @IsString() name?: string
}

class PasswordLoginDto {
  @IsEmail() email!: string
  @IsString() password!: string
}

class SetPasswordDto {
  @IsString() @MinLength(8) password!: string
}

function setSessionCookie(res: Response, token: string) {
  res.cookie('archetype_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    domain: process.env.COOKIE_DOMAIN || undefined,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  })
}

@ApiTags('auth')
@Controller('v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // ── Magic link ───────────────────────────────────────────────────────────
  @Post('request-link')
  async requestLink(@Body() dto: RequestLinkDto, @Req() req: Request) {
    // Use the request's own Origin so the emailed link always points back to
    // wherever the request came from (any preview URL, alias, or localhost).
    const origin = (req.headers['origin'] as string | undefined) || process.env.ADMIN_UI_URL || 'http://localhost:5174'
    await this.auth.requestMagicLink(dto.email, dto.name, origin)
    // Always return ok — don't leak whether an account exists.
    return { ok: true }
  }

  @Get('callback')
  async callback(@Query('token') token: string, @Res({ passthrough: true }) res: Response) {
    if (!token) throw new UnauthorizedException('Missing token')
    const session = await this.auth.consumeMagicLink(token)
    setSessionCookie(res, session.token)
    return { ok: true, owner: session.owner }
  }

  // ── Password ─────────────────────────────────────────────────────────────
  @Post('register')
  async register(@Body() dto: PasswordRegisterDto, @Res({ passthrough: true }) res: Response) {
    const { token, owner } = await this.auth.registerWithPassword(dto.email, dto.password, dto.name)
    setSessionCookie(res, token)
    return { ok: true, owner: { id: owner.id, email: owner.email, name: owner.name } }
  }

  @Post('login')
  async login(@Body() dto: PasswordLoginDto, @Res({ passthrough: true }) res: Response) {
    const { token, owner } = await this.auth.loginWithPassword(dto.email, dto.password)
    setSessionCookie(res, token)
    return { ok: true, owner: { id: owner.id, email: owner.email, name: owner.name } }
  }

  @UseGuards(JwtAuthGuard)
  @Post('set-password')
  async setPassword(@Req() req: AuthRequest, @Body() dto: SetPasswordDto) {
    return this.auth.setPassword(req.owner, dto.password)
  }

  // ── Session ──────────────────────────────────────────────────────────────
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Req() req: AuthRequest) {
    return { owner: { id: req.owner.id, email: req.owner.email, name: req.owner.name, hasPassword: !!req.owner.passwordHash } }
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie('archetype_session', { domain: process.env.COOKIE_DOMAIN || undefined })
    return { ok: true }
  }
}
