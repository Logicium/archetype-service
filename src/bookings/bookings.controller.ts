import { Body, Controller, Delete, Get, Header, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import type { Response } from 'express'
import { IsBoolean, IsEmail, IsISO8601, IsObject, IsOptional, IsString, MaxLength } from 'class-validator'
import { BookingsService } from './bookings.service'
import type { BookingConfig } from '../entities/site.entity'
import { JwtAuthGuard, AuthRequest } from '../auth/jwt.guard'

class CreateBookingBody {
  @IsString() siteSlug!: string
  /** Either a platform type ('demo'|'walkthrough'|'photo-campaign') or an owner-defined service id. */
  @IsString() @MaxLength(80) type!: string
  @IsString() @MaxLength(200) name!: string
  @IsEmail() email!: string
  @IsOptional() @IsString() @MaxLength(50) phone?: string
  @IsOptional() @IsString() @MaxLength(2000) notes?: string
  @IsISO8601() scheduledAt!: string
  @IsOptional() @IsString() timezone?: string
}

@ApiTags('bookings')
@Controller('v1/bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  /** GET /v1/bookings/availability?siteSlug=...&type=demo|<service-id> */
  @Get('availability')
  availability(@Query('siteSlug') siteSlug: string, @Query('type') type: string) {
    return this.bookings.listAvailability(siteSlug, type)
  }

  @Post()
  create(@Body() body: CreateBookingBody) {
    return this.bookings.create(body)
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.bookings.getPublic(id)
  }

  @Get(':id/calendar.ics')
  @Header('Content-Type', 'text/calendar; charset=utf-8')
  async ics(@Param('id') id: string, @Res() res: Response) {
    const { filename, body } = await this.bookings.getIcs(id)
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(body)
  }

  /** GET so it works from a one-click email link. */
  @Get(':id/cancel')
  cancel(@Param('id') id: string, @Query('token') token: string) {
    return this.bookings.cancelByToken(id, token)
  }
}

class UpdateBookingConfigBody {
  /** Pass `null` (or omit) to clear the override and fall back to platform defaults. */
  @IsOptional() @IsObject() config?: BookingConfig | null
}

class SetAddOnBody {
  @IsString() addOn!: string
  @IsBoolean() enabled!: boolean
}

@ApiTags('admin:bookings')
@UseGuards(JwtAuthGuard)
@Controller('v1/admin')
export class AdminBookingsController {
  constructor(private readonly bookings: BookingsService) {}

  /** All bookings the owner can see, across all their sites. */
  @Get('bookings')
  listAll(@Req() req: AuthRequest) {
    return this.bookings.listForOwner(req.owner)
  }

  @Delete('bookings/:id')
  cancelBooking(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.bookings.adminCancel(id, req.owner)
  }

  /** Per-site list — used by the Appointments admin page. */
  @Get('sites/:siteId/bookings')
  listForSite(@Param('siteId') siteId: string, @Req() req: AuthRequest) {
    return this.bookings.listForSite(siteId, req.owner)
  }

  @Get('sites/:siteId/booking-config')
  getConfig(@Param('siteId') siteId: string, @Req() req: AuthRequest) {
    return this.bookings.getBookingConfig(siteId, req.owner)
  }

  @Put('sites/:siteId/booking-config')
  updateConfig(@Param('siteId') siteId: string, @Body() body: UpdateBookingConfigBody, @Req() req: AuthRequest) {
    return this.bookings.updateBookingConfig(siteId, req.owner, body.config ?? null)
  }

  @Post('sites/:siteId/addons')
  setAddOn(@Param('siteId') siteId: string, @Body() body: SetAddOnBody, @Req() req: AuthRequest) {
    return this.bookings.setAddOn(siteId, req.owner, body.addOn, body.enabled)
  }
}
