import { Module } from '@nestjs/common'
import { ScreenshotService } from './screenshot.service'

@Module({
  providers: [ScreenshotService],
  exports: [ScreenshotService],
})
export class ScreenshotModule {}
