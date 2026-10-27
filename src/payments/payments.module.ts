import { Module } from '@nestjs/common'
import { MikroOrmModule } from '@mikro-orm/nestjs'
import { Owner } from '../entities/owner.entity'
import { AuthModule } from '../auth/auth.module'
import { PaymentsService } from './payments.service'
import { PaymentsController, SquareOAuthController } from './payments.controller'

@Module({
  imports: [MikroOrmModule.forFeature([Owner]), AuthModule],
  controllers: [PaymentsController, SquareOAuthController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
