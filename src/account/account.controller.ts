import { Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { Throttle } from '@nestjs/throttler'
import { JwtAuthGuard, AuthRequest } from '../auth/jwt.guard'
import { AccountService } from './account.service'

@ApiTags('admin:account')
@UseGuards(JwtAuthGuard)
@Controller('v1/admin/account')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  /** Owner-initiated deletion of their account + all associated data. */
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  @Post('deletion-request')
  @HttpCode(200)
  requestDeletion(@Req() req: AuthRequest) {
    return this.account.requestDeletion(req.owner)
  }
}
