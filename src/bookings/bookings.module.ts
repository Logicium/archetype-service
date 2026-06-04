import { Module } from '@nestjs/common'
import { MikroOrmModule } from '@mikro-orm/nestjs'
import { Booking } from '../entities/booking.entity'
import { Site } from '../entities/site.entity'
import { AuthModule } from '../auth/auth.module'
import { BookingsService } from './bookings.service'
import { AdminBookingsController, BookingsController } from './bookings.controller'

@Module({
  imports: [MikroOrmModule.forFeature([Booking, Site]), AuthModule],
  controllers: [BookingsController, AdminBookingsController],
  providers: [BookingsService],
  exports: [BookingsService],
})
export class BookingsModule {}
