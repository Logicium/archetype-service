import { Module } from '@nestjs/common'
import { MikroOrmModule } from '@mikro-orm/nestjs'
import { ConfigModule } from '@nestjs/config'
import { ScheduleModule } from '@nestjs/schedule'
import { ThrottlerModule } from '@nestjs/throttler'
import { BullModule } from '@nestjs/bullmq'
import { CommonModule } from './common/common.module'
import { AuthModule } from './auth/auth.module'
import { SitesModule } from './sites/sites.module'
import { FormsModule } from './forms/forms.module'
import { OrdersModule } from './orders/orders.module'
import { ProvisioningModule } from './provisioning/provisioning.module'
import { ReviewsModule } from './reviews/reviews.module'
import { InstagramModule } from './instagram/instagram.module'
import { AnalyticsModule } from './analytics/analytics.module'
import { DomainsModule } from './domains/domains.module'
import { ExtrasModule } from './extras/extras.module'
import { AiModule } from './ai/ai.module'
import { BookingsModule } from './bookings/bookings.module'
import { LodgingModule } from './lodging/lodging.module'
import { ShopModule } from './shop/shop.module'
import { OrderingModule } from './ordering/ordering.module'
import { TicketingModule } from './ticketing/ticketing.module'
import { PaymentsModule } from './payments/payments.module'

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MikroOrmModule.forRoot(),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    BullModule.forRoot({
      connection: {
        url: redisUrl,
        // Required by BullMQ workers; also needed by managed/TLS providers (Aiven/Upstash)
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      } as never,
    }),
    CommonModule,
    AuthModule,
    SitesModule,
    FormsModule,
    OrdersModule,
    ProvisioningModule,
    ReviewsModule,
    InstagramModule,
    AnalyticsModule,
    DomainsModule,
    ExtrasModule,
    AiModule,
    BookingsModule,
    LodgingModule,
    ShopModule,
    OrderingModule,
    TicketingModule,
    PaymentsModule,
  ],
})
export class AppModule {}

