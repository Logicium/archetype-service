import { Body, Controller, HttpCode, Post } from '@nestjs/common'
import { IsObject, IsOptional, IsString } from 'class-validator'
import { AiService } from './ai.service'

export class SuggestDto {
  /** Which archetype the site is (mesa | hearth | vault | marquee | keystone | '') */
  @IsString()
  archetype!: string
  /** Business / brand name */
  @IsString()
  brand!: string
  /**
   * Which field is being filled. Use dot-path style for nested things:
   * 'tagline', 'blurb', 'storyParagraph', 'service.description',
   * 'room.blurb', 'product.blurb', 'capability.value', etc.
   */
  @IsString()
  field!: string
  /**
   * Any extra context to send along — e.g. service name when writing a
   * service description, or existing paragraphs when writing the next one.
   */
  @IsOptional()
  @IsObject()
  context?: Record<string, string>
}

@Controller('v1/ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Post('suggest')
  @HttpCode(200)
  suggest(@Body() dto: SuggestDto) {
    return this.ai.suggest(dto)
  }
}
