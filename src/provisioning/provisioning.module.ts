import { Module } from '@nestjs/common'
import { MikroOrmModule } from '@mikro-orm/nestjs'
import { BullModule } from '@nestjs/bullmq'
import { Order } from '../entities/order.entity'
import { Site } from '../entities/site.entity'
import { SiteContent } from '../entities/site-content.entity'
import { DeployLog } from '../entities/misc.entity'
import { ProvisioningProcessor } from './provisioning.processor'
import { SiteUpdateProcessor } from './site-update.processor'
import { GitHubProvisioner } from './github.provisioner'
import { VercelProvisioner } from './vercel.provisioner'
import { PROVISION_QUEUE, SITE_UPDATE_QUEUE } from './provisioning.constants'

@Module({
  imports: [
    MikroOrmModule.forFeature([Order, Site, SiteContent, DeployLog]),
    BullModule.registerQueue({ name: PROVISION_QUEUE }, { name: SITE_UPDATE_QUEUE }),
  ],
  providers: [ProvisioningProcessor, SiteUpdateProcessor, GitHubProvisioner, VercelProvisioner],
  exports: [GitHubProvisioner, VercelProvisioner, BullModule],
})
export class ProvisioningModule {}
