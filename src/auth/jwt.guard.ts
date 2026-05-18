import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import type { Request } from 'express'
import { AuthService } from './auth.service'
import { Owner } from '../entities/owner.entity'

export interface AuthRequest extends Request {
  owner: Owner
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { cookies?: Record<string, string>; owner?: Owner }>()
    const token =
      req.cookies?.archetype_session ||
      (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined)
    if (!token) throw new UnauthorizedException('Not signed in')
    const owner = await this.auth.verifySession(token)
    if (!owner) throw new UnauthorizedException('Invalid session')
    req.owner = owner
    return true
  }
}
