import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator'
import { Type } from 'class-transformer'
import { TicketingService } from './ticketing.service'
import type { EventStatus, TicketTier } from '../entities/event.entity'
import { JwtAuthGuard, AuthRequest } from '../auth/jwt.guard'

class PurchaseItemBody {
  @IsString() tierId!: string
  @IsInt() @Min(1) quantity!: number
}

class PurchaseTicketsBody {
  @IsString() siteSlug!: string
  @IsString() eventId!: string
  @IsString() @MaxLength(200) name!: string
  @IsEmail() email!: string
  @IsOptional() @IsString() @MaxLength(50) phone?: string
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PurchaseItemBody)
  items!: PurchaseItemBody[]
}

@ApiTags('ticketing')
@Controller('v1/ticketing')
export class TicketingController {
  constructor(private readonly ticketing: TicketingService) {}

  @Get('events')
  listEvents(@Query('siteSlug') siteSlug: string) {
    return this.ticketing.listPublicEvents(siteSlug)
  }

  @Get('events/:eventId')
  getEvent(@Query('siteSlug') siteSlug: string, @Param('eventId') eventId: string) {
    return this.ticketing.getPublicEvent(siteSlug, eventId)
  }

  @Post('purchase')
  purchase(@Body() body: PurchaseTicketsBody) {
    return this.ticketing.purchase(body)
  }

  @Get('orders/:orderId')
  getOrder(@Param('orderId') orderId: string) {
    return this.ticketing.getOrder(orderId)
  }

  @Get('tickets/:id/cancel')
  cancel(@Param('id') id: string, @Query('token') token: string) {
    return this.ticketing.cancelByToken(id, token)
  }
}

class TierBody {
  @IsString() @MaxLength(80) id!: string
  @IsString() @MaxLength(200) label!: string
  @IsOptional() @IsString() @MaxLength(2000) description?: string
  @IsInt() @Min(0) priceCents!: number
  @IsInt() @Min(-1) capacity!: number
  @IsOptional() @IsBoolean() active?: boolean
}

class EventBody {
  @IsString() @MaxLength(200) title!: string
  @IsOptional() @IsString() @MaxLength(4000) description?: string
  @IsString() startsAt!: string
  @IsOptional() @IsString() endsAt?: string
  @IsOptional() @IsString() @MaxLength(200) venue?: string
  @IsOptional() @IsString() @MaxLength(1000) imageUrl?: string
  @IsOptional() @IsInt() @Min(-1) capacity?: number
  @IsOptional() @IsString() @MaxLength(10) currency?: string
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => TierBody)
  tiers!: TicketTier[]
  @IsOptional() @IsIn(['draft', 'on_sale', 'sold_out', 'cancelled', 'past'])
  status?: EventStatus
}

class EventPatchBody {
  @IsOptional() @IsString() @MaxLength(200) title?: string
  @IsOptional() @IsString() @MaxLength(4000) description?: string
  @IsOptional() @IsString() startsAt?: string
  @IsOptional() @IsString() endsAt?: string
  @IsOptional() @IsString() @MaxLength(200) venue?: string
  @IsOptional() @IsString() @MaxLength(1000) imageUrl?: string
  @IsOptional() @IsInt() @Min(-1) capacity?: number
  @IsOptional() @IsString() @MaxLength(10) currency?: string
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => TierBody)
  tiers?: TicketTier[]
  @IsOptional() @IsIn(['draft', 'on_sale', 'sold_out', 'cancelled', 'past'])
  status?: EventStatus
}

@ApiTags('admin:ticketing')
@UseGuards(JwtAuthGuard)
@Controller('v1/admin/sites/:siteId')
export class AdminTicketingController {
  constructor(private readonly ticketing: TicketingService) {}

  @Get('events')
  list(@Param('siteId') siteId: string, @Req() req: AuthRequest) {
    return this.ticketing.listEvents(siteId, req.owner)
  }

  @Post('events')
  create(@Param('siteId') siteId: string, @Body() body: EventBody, @Req() req: AuthRequest) {
    return this.ticketing.createEvent(siteId, req.owner, body)
  }

  @Put('events/:eventId')
  update(
    @Param('siteId') siteId: string,
    @Param('eventId') eventId: string,
    @Body() body: EventPatchBody,
    @Req() req: AuthRequest,
  ) {
    return this.ticketing.updateEvent(siteId, req.owner, eventId, body)
  }

  @Delete('events/:eventId')
  remove(@Param('siteId') siteId: string, @Param('eventId') eventId: string, @Req() req: AuthRequest) {
    return this.ticketing.deleteEvent(siteId, req.owner, eventId)
  }

  @Get('events/:eventId/tickets')
  listTickets(@Param('siteId') siteId: string, @Param('eventId') eventId: string, @Req() req: AuthRequest) {
    return this.ticketing.listEventTickets(siteId, req.owner, eventId)
  }

  @Delete('tickets/:ticketId')
  cancelTicket(@Param('siteId') siteId: string, @Param('ticketId') ticketId: string, @Req() req: AuthRequest) {
    return this.ticketing.adminCancelTicket(siteId, req.owner, ticketId)
  }

  @Patch('tickets/:ticketId/check-in')
  checkIn(@Param('siteId') siteId: string, @Param('ticketId') ticketId: string, @Req() req: AuthRequest) {
    return this.ticketing.checkInTicket(siteId, req.owner, ticketId)
  }
}
