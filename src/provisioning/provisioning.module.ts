import { Module } from '@nestjs/common'
import { MikroOrmModule } from '@mikro-orm/nestjs'
import { BullModule } from '@nestjs/bullmq'
import { Order } from '../entities/order.entity'
import { Site } from '../entities/site.entity'
import { DeployLog } from '../entities/misc.entity'
import { SitesModule } from '../sites/sites.module'
import { ProvisioningProcessor } from './provisioning.processor'
import { GitHubProvisioner } from './github.provisioner'
import { VercelProvisioner } from './vercel.provisioner'
import { PROVISION_QUEUE } from './provisioning.constants'

@Module({
  imports: [
    MikroOrmModule.forFeature([Order, Site, DeployLog]),
    BullModule.registerQueue({ name: PROVISION_QUEUE }),
    SitesModule,
  ],
  providers: [ProvisioningProcessor, GitHubProvisioner, VercelProvisioner],
  exports: [GitHubProvisioner, VercelProvisioner],
})
export class ProvisioningModule {}
