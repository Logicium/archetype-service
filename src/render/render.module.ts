import { Module } from '@nestjs/common'
import { RenderService } from './render.service'
import { RenderController } from './render.controller'

/**
 * Chromium, exposed to the studio's other services.
 *
 * Exported so ScreenshotService can share the same launcher rather than
 * carrying a second copy of the memory flags that drifts from this one.
 */
@Module({
  controllers: [RenderController],
  providers: [RenderService],
  exports: [RenderService],
})
export class RenderModule {}
