import { Body, Controller, Get, Headers, Post, Req, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { IsOptional, IsString, MaxLength } from 'class-validator'
import { PaymentsService } from './payments.service'
import { JwtAuthGuard, AuthRequest } from '../auth/jwt.guard'

function originFrom(header: string | undefined): string {
  if (header) {
    try {
      const u = new URL(header)
      if (u.protocol === 'http:' || u.protocol === 'https:') return `${u.protocol}//${u.host}`
    } catch { /* fall through */ }
  }
  return process.env.PUBLIC_APP_URL || 'http://localhost:5173'
}

class ExchangeBody {
  @IsString() @MaxLength(500) publicToken!: string
  @IsString() @MaxLength(200) accountId!: string
}

class OnboardBody {
  @IsOptional() @IsString() @MaxLength(500) returnTo?: string
}

/**
 * Owner-level payments admin. Not scoped to a single site — a Connect account
 * and linked bank belong to the owner and apply across all their sites.
 */
@ApiTags('admin:payments')
@UseGuards(JwtAuthGuard)
@Controller('v1/admin/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('status')
  status(@Req() req: AuthRequest) {
    return this.payments.getStatus(req.owner)
  }

  @Post('connect')
  connect(@Req() req: AuthRequest, @Headers('origin') origin: string | undefined, @Body() body: OnboardBody) {
    return this.payments.createOnboardingLink(req.owner, body.returnTo || originFrom(origin))
  }

  @Post('plaid/link-token')
  linkToken(@Req() req: AuthRequest) {
    return this.payments.createPlaidLinkToken(req.owner)
  }

  @Post('plaid/exchange')
  exchange(@Req() req: AuthRequest, @Body() body: ExchangeBody) {
    return this.payments.exchangePlaidPublicToken(req.owner, body.publicToken, body.accountId)
  }
}
