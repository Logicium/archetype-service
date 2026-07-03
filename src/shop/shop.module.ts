import { Module } from '@nestjs/common'
import { MikroOrmModule } from '@mikro-orm/nestjs'
import { Product } from '../entities/product.entity'
import { ShopOrder } from '../entities/shop-order.entity'
import { Site } from '../entities/site.entity'
import { AuthModule } from '../auth/auth.module'
import { PaymentsModule } from '../payments/payments.module'
import { ShopService } from './shop.service'
import { AdminShopController, ShopController } from './shop.controller'

@Module({
  imports: [MikroOrmModule.forFeature([Product, ShopOrder, Site]), AuthModule, PaymentsModule],
  controllers: [ShopController, AdminShopController],
  providers: [ShopService],
  exports: [ShopService],
})
export class ShopModule {}
