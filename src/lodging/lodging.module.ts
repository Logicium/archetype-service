import { Module } from '@nestjs/common'
import { MikroOrmModule } from '@mikro-orm/nestjs'
import { Reservation } from '../entities/reservation.entity'
import { Site } from '../entities/site.entity'
import { AuthModule } from '../auth/auth.module'
import { LodgingService } from './lodging.service'
import { AdminLodgingController, ReservationsController } from './lodging.controller'

@Module({
  imports: [MikroOrmModule.forFeature([Reservation, Site]), AuthModule],
  controllers: [ReservationsController, AdminLodgingController],
  providers: [LodgingService],
  exports: [LodgingService],
})
export class LodgingModule {}
