import { Body, Controller, Post, UseGuards } from '@nestjs/common'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator'
import { ServiceKeyGuard } from '../common/service-key.guard'
import { RenderService } from './render.service'

class ScreenshotDto {
  @IsString() @IsNotEmpty() url!: string
  @IsOptional() @IsInt() @Min(320) @Max(2560) width?: number
  @IsOptional() @IsInt() @Min(240) @Max(4000) height?: number
  @IsOptional() @IsInt() @Min(1) @Max(3) deviceScaleFactor?: number
  @IsOptional() @IsBoolean() isMobile?: boolean
  @IsOptional() @IsBoolean() fullPage?: boolean
  @IsOptional() @IsInt() @Min(0) @Max(10_000) settleMs?: number
  @IsOptional() @IsInt() @Min(1000) @Max(45_000) timeoutMs?: number
}

class PdfDto {
  @IsString() @IsNotEmpty() html!: string
  @IsOptional() @IsIn(['letter', 'a4', 'legal']) format?: 'letter' | 'a4' | 'legal'
  @IsOptional() @IsBoolean() printBackground?: boolean
  @IsOptional() @IsBoolean() preferCSSPageSize?: boolean
  @IsOptional() @IsInt() @Min(1000) @Max(45_000) timeoutMs?: number
}

/**
 * Rendering for the studio's other services.
 *
 * This container has the headroom for Chromium; apotome-labs-service does not,
 * and gets OOM-killed by it. Both its screenshot capture and its contract PDF
 * renderer call here, keeping their local paths only as a fallback.
 *
 * Base64 in a JSON envelope rather than a binary body: it keeps the existing
 * pipes, guards and error shapes, and a 1200x750 PNG is only a few hundred
 * kilobytes encoded.
 */
@Controller('v1/render')
@UseGuards(ServiceKeyGuard, ThrottlerGuard)
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class RenderController {
  constructor(private readonly render: RenderService) {}

  @Post('screenshot')
  async screenshot(@Body() dto: ScreenshotDto) {
    // before the browser starts, not after: the point is not to fetch it at all
    await this.render.assertPublicUrl(dto.url)
    const png = await this.render.capturePng(dto)
    return { ok: true, contentType: 'image/png', base64: png.toString('base64') }
  }

  @Post('pdf')
  async pdf(@Body() dto: PdfDto) {
    const buffer = await this.render.renderPdf(dto)
    return { ok: true, contentType: 'application/pdf', base64: buffer.toString('base64') }
  }
}
