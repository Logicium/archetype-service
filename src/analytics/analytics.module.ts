import { Module } from '@nestjs/common'
import { MikroOrmModule } from '@mikro-orm/nestjs'
import { Site } from '../entities/site.entity'
import { SiteMetric, PageHit } from '../entities/misc.entity'
import { AnalyticsController, AnalyticsIngestController, UptimeService } from './analytics.controller'
import { SitesModule } from '../sites/sites.module'
import { AuthModule } from '../auth/auth.module'

@Module({
  imports: [MikroOrmModule.forFeature([Site, SiteMetric, PageHit]), SitesModule, AuthModule],
  controllers: [AnalyticsIngestController, AnalyticsController],
  providers: [UptimeService],
})
export class AnalyticsModule {}
