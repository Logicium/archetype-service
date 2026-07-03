import { Module } from '@nestjs/common'
import { MikroOrmModule } from '@mikro-orm/nestjs'
import { Site } from '../entities/site.entity'
import { AdminInstagramController, InstagramOAuthController, InstagramTokenService, PublicInstagramController } from './instagram.controller'
import { SitesModule } from '../sites/sites.module'
import { AuthModule } from '../auth/auth.module'

@Module({
  imports: [MikroOrmModule.forFeature([Site]), SitesModule, AuthModule],
  controllers: [PublicInstagramController, InstagramOAuthController, AdminInstagramController],
  providers: [InstagramTokenService],
})
export class InstagramModule {}
