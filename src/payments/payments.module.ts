import { Module } from '@nestjs/common'
import { MikroOrmModule } from '@mikro-orm/nestjs'
import { Owner } from '../entities/owner.entity'
import { AuthModule } from '../auth/auth.module'
import { PaymentsService } from './payments.service'
import { PaymentsController } from './payments.controller'

@Module({
  imports: [MikroOrmModule.forFeature([Owner]), AuthModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
