import { Module } from '@nestjs/common'
import { PaymentsModule } from './payments.module'
import { ShopModule } from '../shop/shop.module'
import { OrderingModule } from '../ordering/ordering.module'
import { ConnectWebhookController } from './connect-webhook.controller'

/**
 * Lives apart from PaymentsModule because it needs the commerce services
 * (shop, ordering) that themselves import PaymentsModule.
 */
@Module({
  imports: [PaymentsModule, ShopModule, OrderingModule],
  controllers: [ConnectWebhookController],
})
export class ConnectWebhookModule {}
