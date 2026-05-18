import { Module } from '@nestjs/common'
import { MikroOrmModule } from '@mikro-orm/nestjs'
import { Review } from '../entities/misc.entity'
import { Site } from '../entities/site.entity'
import { AdminReviewsController, PublicReviewsController, ReviewsService } from './reviews.controller'
import { SitesModule } from '../sites/sites.module'
import { AuthModule } from '../auth/auth.module'

@Module({
  imports: [MikroOrmModule.forFeature([Review, Site]), SitesModule, AuthModule],
  controllers: [PublicReviewsController, AdminReviewsController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
