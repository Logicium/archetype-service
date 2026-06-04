import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator'
import { Type } from 'class-transformer'
import { OrderingService } from './ordering.service'
import type { OrderingConfig } from '../entities/site.entity'
import { JwtAuthGuard, AuthRequest } from '../auth/jwt.guard'

class MealOrderItemBody {
  @IsString() menuItemId!: string
  @IsInt() @Min(1) quantity!: number
  @IsOptional() @IsString() @MaxLength(300) notes?: string
}

class CreateMealOrderBody {
  @IsString() siteSlug!: string
  @IsString() @MaxLength(200) name!: string
  @IsEmail() email!: string
  @IsOptional() @IsString() @MaxLength(50) phone?: string
  @IsOptional() @IsString() @MaxLength(2000) notes?: string
  @IsString() pickupAt!: string
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => MealOrderItemBody)
  items!: MealOrderItemBody[]
}

@ApiTags('ordering')
@Controller('v1/ordering')
export class OrderingController {
  constructor(private readonly ordering: OrderingService) {}

  @Get('menu')
  menu(@Query('siteSlug') siteSlug: string) {
    return this.ordering.listPublicMenu(siteSlug)
  }

  @Get('slots')
  slots(@Query('siteSlug') siteSlug: string) {
    return this.ordering.listSlots(siteSlug)
  }

  @Post('orders')
  create(@Body() body: CreateMealOrderBody) {
    return this.ordering.createOrder(body)
  }

  @Get('orders/:id')
  get(@Param('id') id: string) {
    return this.ordering.getPublicOrder(id)
  }
}

class MenuItemBody {
  @IsString() @MaxLength(80) sku!: string
  @IsString() @MaxLength(200) name!: string
  @IsOptional() @IsString() @MaxLength(4000) description?: string
  @IsInt() @Min(0) priceCents!: number
  @IsOptional() @IsString() @MaxLength(10) currency?: string
  @IsOptional() @IsString() @MaxLength(80) category?: string
  @IsOptional() @IsString() @MaxLength(1000) imageUrl?: string
  @IsOptional() @IsBoolean() active?: boolean
  @IsOptional() @IsInt() sortOrder?: number
}

class MenuItemPatchBody {
  @IsOptional() @IsString() @MaxLength(80) sku?: string
  @IsOptional() @IsString() @MaxLength(200) name?: string
  @IsOptional() @IsString() @MaxLength(4000) description?: string
  @IsOptional() @IsInt() @Min(0) priceCents?: number
  @IsOptional() @IsString() @MaxLength(10) currency?: string
  @IsOptional() @IsString() @MaxLength(80) category?: string
  @IsOptional() @IsString() @MaxLength(1000) imageUrl?: string
  @IsOptional() @IsBoolean() active?: boolean
  @IsOptional() @IsInt() sortOrder?: number
}

class UpdateOrderingConfigBody {
  @IsOptional() @IsObject() config?: OrderingConfig | null
}

class UpdateMealOrderStatusBody {
  @IsIn(['pending', 'confirmed', 'ready', 'completed', 'cancelled'])
  status!: 'pending' | 'confirmed' | 'ready' | 'completed' | 'cancelled'
}

@ApiTags('admin:ordering')
@UseGuards(JwtAuthGuard)
@Controller('v1/admin/sites/:siteId')
export class AdminOrderingController {
  constructor(private readonly ordering: OrderingService) {}

  @Get('menu-items')
  listMenu(@Param('siteId') siteId: string, @Req() req: AuthRequest) {
    return this.ordering.listMenuForSite(siteId, req.owner)
  }

  @Post('menu-items')
  createItem(@Param('siteId') siteId: string, @Body() body: MenuItemBody, @Req() req: AuthRequest) {
    return this.ordering.createMenuItem(siteId, req.owner, body)
  }

  @Patch('menu-items/:itemId')
  updateItem(
    @Param('siteId') siteId: string,
    @Param('itemId') itemId: string,
    @Body() body: MenuItemPatchBody,
    @Req() req: AuthRequest,
  ) {
    return this.ordering.updateMenuItem(siteId, req.owner, itemId, body)
  }

  @Delete('menu-items/:itemId')
  deleteItem(@Param('siteId') siteId: string, @Param('itemId') itemId: string, @Req() req: AuthRequest) {
    return this.ordering.deleteMenuItem(siteId, req.owner, itemId)
  }

  @Get('meal-orders')
  listOrders(@Param('siteId') siteId: string, @Req() req: AuthRequest) {
    return this.ordering.listOrders(siteId, req.owner)
  }

  @Patch('meal-orders/:orderId')
  updateOrder(
    @Param('siteId') siteId: string,
    @Param('orderId') orderId: string,
    @Body() body: UpdateMealOrderStatusBody,
    @Req() req: AuthRequest,
  ) {
    return this.ordering.updateOrderStatus(siteId, req.owner, orderId, body.status)
  }

  @Get('ordering-config')
  getConfig(@Param('siteId') siteId: string, @Req() req: AuthRequest) {
    return this.ordering.getOrderingConfig(siteId, req.owner)
  }

  @Put('ordering-config')
  updateConfig(@Param('siteId') siteId: string, @Body() body: UpdateOrderingConfigBody, @Req() req: AuthRequest) {
    return this.ordering.updateOrderingConfig(siteId, req.owner, body.config ?? null)
  }
}
