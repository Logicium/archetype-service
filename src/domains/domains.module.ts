import { Module } from '@nestjs/common'
import { DomainsController } from './domains.controller'
import { SitesModule } from '../sites/sites.module'
import { AuthModule } from '../auth/auth.module'
import { ProvisioningModule } from '../provisioning/provisioning.module'

@Module({
  imports: [SitesModule, AuthModule, ProvisioningModule],
  controllers: [DomainsController],
})
export class DomainsModule {}
