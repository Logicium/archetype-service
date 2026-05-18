import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Post, RawBodyRequest, Req, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import type { Request } from 'express'
import { IsArray, IsEmail, IsIn, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'
import { OrdersService } from './orders.service'
import { JwtAuthGuard, AuthRequest } from '../auth/jwt.guard'

class OwnerDto {
  @IsEmail() email!: string
  @IsOptional() @IsString() name?: string
}

class CreateOrderDto {
  @IsIn(['mesa', 'hearth', 'vault', 'keystone']) archetype!: 'mesa' | 'hearth' | 'vault' | 'keystone'
  @IsString() plan!: string
  @IsArray() @IsString({ each: true }) addOns: string[] = []
  @IsObject() wizardPayload!: Record<string, unknown>
  @ValidateNested() @Type(() => OwnerDto) owner!: OwnerDto
}

@ApiTags('orders')
@Controller('v1/orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  async create(@Body() dto: CreateOrderDto) {
    return this.orders.createCheckoutSession(dto)
  }

  @Get(':id')
  async status(@Param('id') id: string) {
    return this.orders.getPublicStatus(id)
  }
}

@ApiTags('webhooks')
@Controller('v1/webhooks')
export class WebhooksController {
  constructor(private readonly orders: OrdersService) {}

  @Post('stripe')
  @HttpCode(200)
  async stripe(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') sig?: string) {
    if (!sig) throw new BadRequestException('Missing signature')
    const buf = req.rawBody
    if (!buf) throw new BadRequestException('Missing raw body')
    await this.orders.handleStripeWebhook(buf, sig)
    return { received: true }
  }
}

@ApiTags('admin:orders')
@UseGuards(JwtAuthGuard)
@Controller('v1/admin/orders')
export class AdminOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(@Req() req: AuthRequest) {
    return this.orders.listForOwner(req.owner)
  }

  @Post(':id/retry')
  retry(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.orders.retryProvisioning(id, req.owner)
  }
}
