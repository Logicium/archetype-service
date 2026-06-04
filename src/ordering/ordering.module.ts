import { Module } from '@nestjs/common'
import { MikroOrmModule } from '@mikro-orm/nestjs'
import { MenuItem } from '../entities/menu-item.entity'
import { MealOrder } from '../entities/meal-order.entity'
import { Site } from '../entities/site.entity'
import { AuthModule } from '../auth/auth.module'
import { OrderingService } from './ordering.service'
import { AdminOrderingController, OrderingController } from './ordering.controller'

@Module({
  imports: [MikroOrmModule.forFeature([MenuItem, MealOrder, Site]), AuthModule],
  controllers: [OrderingController, AdminOrderingController],
  providers: [OrderingService],
  exports: [OrderingService],
})
export class OrderingModule {}
