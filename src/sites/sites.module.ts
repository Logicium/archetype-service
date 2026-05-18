import { Module } from '@nestjs/common'
import { MikroOrmModule } from '@mikro-orm/nestjs'
import { Site } from '../entities/site.entity'
import { SiteContent } from '../entities/site-content.entity'
import { DeployLog } from '../entities/misc.entity'
import { SitesService } from './sites.service'
import { AdminSitesController, PublicSitesController } from './sites.controller'
import { AuthModule } from '../auth/auth.module'
import { ProvisioningModule } from '../provisioning/provisioning.module'

@Module({
  imports: [MikroOrmModule.forFeature([Site, SiteContent, DeployLog]), AuthModule, ProvisioningModule],
  controllers: [PublicSitesController, AdminSitesController],
  providers: [SitesService],
  exports: [SitesService],
})
export class SitesModule {}
