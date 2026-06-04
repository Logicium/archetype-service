import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { IsBoolean, IsEmail, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator'
import { LodgingService } from './lodging.service'
import type { LodgingConfig } from '../entities/site.entity'
import { JwtAuthGuard, AuthRequest } from '../auth/jwt.guard'

const DATE = /^\d{4}-\d{2}-\d{2}$/

class CreateReservationBody {
  @IsString() siteSlug!: string
  @IsString() @MaxLength(80) roomId!: string
  @Matches(DATE) checkIn!: string
  @Matches(DATE) checkOut!: string
  @IsInt() @Min(1) @Max(20) partySize!: number
  @IsString() @MaxLength(200) name!: string
  @IsEmail() email!: string
  @IsOptional() @IsString() @MaxLength(50) phone?: string
  @IsOptional() @IsString() @MaxLength(2000) notes?: string
}

@ApiTags('reservations')
@Controller('v1/reservations')
export class ReservationsController {
  constructor(private readonly lodging: LodgingService) {}

  /** GET /v1/reservations/availability?siteSlug=...&checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD&partySize=2 */
  @Get('availability')
  availability(
    @Query('siteSlug') siteSlug: string,
    @Query('checkIn') checkIn: string,
    @Query('checkOut') checkOut: string,
    @Query('partySize') partySize?: string,
  ) {
    return this.lodging.listAvailability(siteSlug, checkIn, checkOut, Math.max(1, parseInt(partySize || '1', 10) || 1))
  }

  @Post()
  create(@Body() body: CreateReservationBody) {
    return this.lodging.create(body)
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.lodging.getPublic(id)
  }

  @Get(':id/cancel')
  cancel(@Param('id') id: string, @Query('token') token: string) {
    return this.lodging.cancelByToken(id, token)
  }
}

class UpdateLodgingConfigBody {
  @IsOptional() @IsObject() config?: LodgingConfig | null
}

class SetAddOnBody {
  @IsString() addOn!: string
  @IsBoolean() enabled!: boolean
}

@ApiTags('admin:lodging')
@UseGuards(JwtAuthGuard)
@Controller('v1/admin/sites/:siteId')
export class AdminLodgingController {
  constructor(private readonly lodging: LodgingService) {}

  @Get('reservations')
  list(@Param('siteId') siteId: string, @Req() req: AuthRequest) {
    return this.lodging.listForSite(siteId, req.owner)
  }

  @Delete('reservations/:id')
  cancel(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.lodging.adminCancel(id, req.owner)
  }

  @Get('lodging-config')
  getConfig(@Param('siteId') siteId: string, @Req() req: AuthRequest) {
    return this.lodging.getLodgingConfig(siteId, req.owner)
  }

  @Put('lodging-config')
  updateConfig(@Param('siteId') siteId: string, @Body() body: UpdateLodgingConfigBody, @Req() req: AuthRequest) {
    return this.lodging.updateLodgingConfig(siteId, req.owner, body.config ?? null)
  }
}

// `SetAddOnBody` re-uses the existing `POST /v1/admin/sites/:id/addons` from BookingsModule.
void SetAddOnBody
