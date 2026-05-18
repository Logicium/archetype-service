import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { MikroOrmModule } from '@mikro-orm/nestjs'
import { Owner } from '../entities/owner.entity'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { JwtAuthGuard } from './jwt.guard'

@Module({
  imports: [
    MikroOrmModule.forFeature([Owner]),
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'dev-secret-change-me',
      signOptions: { algorithm: 'HS256' },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  exports: [AuthService, JwtAuthGuard, JwtModule],
})
export class AuthModule {}
