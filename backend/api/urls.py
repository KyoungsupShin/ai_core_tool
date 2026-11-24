from django.urls import path
from . import views

urlpatterns = [
    path('health/', views.health),
    path('models/', views.models),
    path('pricing/', views.pricing),
    path('compute-instances/', views.compute_instances),
    path('estimates/', views.estimate),
]
