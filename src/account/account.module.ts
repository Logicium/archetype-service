import { Module } from '@nestjs/common'
import { AccountController } from './account.controller'
import { AccountService } from './account.service'
import { SitesModule } from '../sites/sites.module'
import { AuthModule } from '../auth/auth.module'

@Module({
  imports: [SitesModule, AuthModule],
  controllers: [AccountController],
  providers: [AccountService],
})
export class AccountModule {}
