import { Module } from '@nestjs/common'
import { MikroOrmModule } from '@mikro-orm/nestjs'
import { Site } from '../entities/site.entity'
import { SiteMetric } from '../entities/misc.entity'
import { AnalyticsController, UptimeService } from './analytics.controller'
import { SitesModule } from '../sites/sites.module'
import { AuthModule } from '../auth/auth.module'

@Module({
  imports: [MikroOrmModule.forFeature([Site, SiteMetric]), SitesModule, AuthModule],
  controllers: [AnalyticsController],
  providers: [UptimeService],
})
export class AnalyticsModule {}
