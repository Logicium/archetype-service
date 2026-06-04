import { Module } from '@nestjs/common'
import { MikroOrmModule } from '@mikro-orm/nestjs'
import { Event, Ticket } from '../entities/event.entity'
import { Site } from '../entities/site.entity'
import { AuthModule } from '../auth/auth.module'
import { TicketingService } from './ticketing.service'
import { AdminTicketingController, TicketingController } from './ticketing.controller'

@Module({
  imports: [MikroOrmModule.forFeature([Event, Ticket, Site]), AuthModule],
  controllers: [TicketingController, AdminTicketingController],
  providers: [TicketingService],
  exports: [TicketingService],
})
export class TicketingModule {}
