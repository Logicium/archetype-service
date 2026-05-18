import { Module } from '@nestjs/common'
import { MikroOrmModule } from '@mikro-orm/nestjs'
import { FormSubmission } from '../entities/misc.entity'
import { FormsAdminController, FormsController } from './forms.controller'
import { SitesModule } from '../sites/sites.module'
import { AuthModule } from '../auth/auth.module'

@Module({
  imports: [MikroOrmModule.forFeature([FormSubmission]), SitesModule, AuthModule],
  controllers: [FormsController, FormsAdminController],
})
export class FormsModule {}
