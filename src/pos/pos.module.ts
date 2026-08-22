import { Module } from '@nestjs/common'
import { MikroOrmModule } from '@mikro-orm/nestjs'
import { MealOrder } from '../entities/meal-order.entity'
import { Site } from '../entities/site.entity'
import { AuthModule } from '../auth/auth.module'
import { PosService } from './pos.service'
import { AdminPosController, PosOAuthController } from './pos.controller'

@Module({
  imports: [MikroOrmModule.forFeature([Site, MealOrder]), AuthModule],
  controllers: [PosOAuthController, AdminPosController],
  providers: [PosService],
  exports: [PosService],
})
export class PosModule {}
