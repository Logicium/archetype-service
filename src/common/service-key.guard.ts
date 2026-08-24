import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { timingSafeEqual } from 'crypto'
import type { Request } from 'express'

/**
 * Authenticates another one of the studio's services, not a person.
 *
 * There was no shared-secret guard in this codebase before; every admin route
 * here goes through a user session. The render endpoints are different: the
 * caller is apotome-labs-service, which has no user to speak for.
 *
 * Fails closed when RENDER_SERVICE_KEY is unset, so a misconfigured deploy
 * refuses work rather than opening a browser to anyone who asks.
 */
@Injectable()
export class ServiceKeyGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const expected = process.env.RENDER_SERVICE_KEY
    if (!expected) throw new UnauthorizedException()

    const req = ctx.switchToHttp().getRequest<Request>()
    const provided = String(req.headers['x-service-key'] ?? '')

    const a = Buffer.from(provided)
    const b = Buffer.from(expected)
    // length is checked first because timingSafeEqual throws on a mismatch
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException()
    }
    return true
  }
}
