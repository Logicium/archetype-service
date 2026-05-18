import { Module } from '@nestjs/common'
import { AiController, MediaController } from './extras.controller'
import { SitesModule } from '../sites/sites.module'
import { AuthModule } from '../auth/auth.module'

@Module({
  imports: [SitesModule, AuthModule],
  controllers: [AiController, MediaController],
})
export class ExtrasModule {}
