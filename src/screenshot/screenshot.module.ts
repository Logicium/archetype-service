import { Module } from '@nestjs/common'
import { ScreenshotService } from './screenshot.service'
import { RenderModule } from '../render/render.module'

@Module({
  imports: [RenderModule],
  providers: [ScreenshotService],
  exports: [ScreenshotService],
})
export class ScreenshotModule {}
