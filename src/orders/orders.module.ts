import { Module } from '@nestjs/common'
import { MikroOrmModule } from '@mikro-orm/nestjs'
import { BullModule } from '@nestjs/bullmq'
import { Order } from '../entities/order.entity'
import { Owner } from '../entities/owner.entity'
import { AdminOrdersController, OrdersController, WebhooksController } from './orders.controller'
import { OrdersService } from './orders.service'
import { AuthModule } from '../auth/auth.module'
import { PROVISION_QUEUE } from '../provisioning/provisioning.constants'

@Module({
  imports: [
    MikroOrmModule.forFeature([Order, Owner]),
    BullModule.registerQueue({ name: PROVISION_QUEUE }),
    AuthModule,
  ],
  controllers: [OrdersController, WebhooksController, AdminOrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
